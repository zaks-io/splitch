# Exposures endpoint: `POST /api/sdk/exposures` (redeem Exposure Tickets, batched)

The write half of the ADR-0048 decoupling. A payload-backed client reports that an Entity actually
encountered its assigned Variant by **redeeming the Exposure Ticket** that
[`evaluate-all`](./evaluate-all-endpoint.md) issued for that Flag. The Worker verifies the ticket,
seals the canonical Exposure — identical payload to the one `evaluate` seals inline
([exposure-accessor.md](./exposure-accessor.md)) — and then triggers the Assignment Store `put`.
Every Exposure-relevant field is derived from the **verified ticket**, never from client assertion:
a client cannot claim a Variant it was not assigned.

## Exposure Ticket

An opaque string minted by the Evaluation Worker during `evaluate-all`, only for fresh live-Run
assignments. Structure (server-internal; clients must treat it as opaque):

```
ExposureTicket = base64url( payload ) + "." + base64url( HMAC-SHA256(payload, ticketKey) )

payload {
  app_id, environment_id, experiment_id, run_id, flag_key,
  variant:            string      -- Variant NAME (immutable arm label), never the value
  id_type:            string
  targeting_key_hash: string      -- derived server-side; the raw Targeting Key is never in a ticket
  issued_at:          timestamp   -- UTC; server clock
}
```

- **Stateless**: verification recomputes the MAC — no lookup, no per-ticket storage (ADR-0048).
- **TTL**: a ticket older than **24 hours** is rejected `EXPOSURE_TICKET_EXPIRED`. The client's
  remediation is a fresh `evaluate-all` (revalidation would have replaced it long before).
- **Key rotation**: the Worker verifies against the current and the immediately previous
  `ticketKey`, so routine rotation never invalidates in-flight tickets (same rotation posture as
  ADR-0044). The key is a Worker secret; it never reaches clients, D1, or Tinybird.
- **Not a secret, not a credential**: tickets ride inside Precomputed Evaluations, including ones
  serialized into public HTML for bootstrap. Possession only enables reporting the one Exposure the
  server already resolved; a scraped or replayed ticket at worst re-appends a raw row that
  collapses to the existing first touch (ADR-0005; see Integrity).

## Endpoint

```
POST /api/sdk/exposures
Authorization: Bearer <clientKey | apiKey>   -- Client Key is the primary caller (browser SDK)
Content-Type: application/json
```

Environment and `app_id` authority come from the credential, exactly as on
[evaluate-all-endpoint.md](./evaluate-all-endpoint.md). The credential's `(app_id, environment_id)`
must match the ticket's — a ticket redeemed under a different tenant's credential is rejected
`EXPOSURE_TICKET_INVALID` (cross-tenant redemption is structurally impossible).

## Batch envelope

Mirrors the Web Event batch contract (`packages/sdk/CONTEXT.md`) deliberately — one envelope
discipline for both public batch-ingest surfaces:

```
ExposureBatchRequest {
  exposures: [                       -- non-empty; max 25 items; max 32 KiB UTF-8 JSON body
    {
      exposureId:      string        -- SDK-minted stable UUID per logical first read; reused on retry
      exposureTicket:  string        -- the opaque ticket being redeemed
      clientTimestamp: timestamp     -- client-fired time; diagnostics only (clock skew expected)
    }
  ]
}
```

- Batch-level auth or structural failures (bad credential, malformed envelope, over-cap) reject the
  **whole request** loudly — an over-cap batch is never silently truncated; the SDK splits batches
  client-side.
- After the batch gates pass, each item is **accepted, deduplicated, or rejected independently** by
  `exposureId`; an invalid item does not block valid siblings.
- Retry identity is per item: the SDK reuses `exposureId` when re-flushing an unacknowledged item;
  reusing an `exposureId` with a different ticket is `EVENT_ID_CONFLICT`. Application code never
  manages these IDs (unlike `evaluate`'s caller-owned `idempotencyKey` — the SDK owns the queue, so
  the SDK owns retry identity, same as Web Track).

### Response

```
ExposureBatchResponse {
  results: [                         -- same order as the request items
    { exposureId: string, status: 'accepted' | 'deduplicated' | 'rejected' | 'suppressed',
      code: ErrorCode | null }       -- non-null only when status = 'rejected'
  ]
}
```

`deduplicated` means this `exposureId` was already durably accepted — the ack a re-flush expects.
`suppressed` means Entity/App deletion cutoff owned the slot — **not** holdover completion; the
SDK drops the queue item the same way as `accepted`/`deduplicated` (no retry), but callers must
not treat it as a successful Assignment Store write.

## Redemption semantics

For each accepted item, in order:

```
1. Verify MAC (current or previous ticketKey) and TTL      -> EXPOSURE_TICKET_INVALID / _EXPIRED
2. Verify ticket tenant == credential tenant               -> EXPOSURE_TICKET_INVALID
3. Seal the canonical Exposure payload in the Event Ingest raw_events outbox
   (field-for-field the table in exposure-accessor.md; exposure_at = server_received_at = now;
    event_id / dedup_key generated per row as for evaluate)
4. Await Assignment Store holdover-write ownership on the Evaluation Worker:
   seal durable outbox ownership for the ticket, then attempt putIfAbsent → KV
   write-through inline. Ownership or KV-complete success may ack; transport /
   ownership failure rejects so the SDK retains the queue item. Exhausted
   retries fail loud (`INTERNAL_SERVER_ERROR`). Deletion cutoff returns
   per-item `suppressed` (not `accepted`).
```

Ingest-write failure rejects the item loud and performs no Assignment Store write.
Confirm/acknowledge claim-store faults still schedule the holdover Assignment Store
write before returning `rejected` (the Exposure row already committed). Per-item
rejection codes fall into two classes the SDK must distinguish:

| Class         | Codes                                                                                                                                                      | SDK behavior                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Transient     | `SERVICE_UNAVAILABLE`                                                                                                                                      | Retain the item and retry with the same `exposureId`   |
| Deterministic | `VALIDATION_ERROR`, `INTERNAL_SERVER_ERROR`, `EXPOSURE_TICKET_INVALID`, `EXPOSURE_TICKET_EXPIRED`, `EVENT_ID_CONFLICT`, and every other non-transient code | Acknowledge as failed, log loud, drop — never re-queue |

Mapping:

- Transient or platform-side **ingest** faults (internal-token drift / 401, config propagation
  lag / 404, rate limits / 429, and other non-400 ingest statuses) → `SERVICE_UNAVAILABLE`.
- Unambiguous caller-payload fault from ingest (HTTP 400) → non-retryable `VALIDATION_ERROR`.
- Transient **claim-store** fault (Durable Object transport failure — including a
  body-read network failure after a 200 header — or an HTTP status outside the
  Durable Object handler vocabulary, e.g. platform-injected 408 / 425 / 429 / 5xx) →
  `SERVICE_UNAVAILABLE`.
- Deterministic **claim-store** fault (programming error in the redemption path, a
  `parseClaimOutcome` / `parseAcknowledgeOutcome` / `parseOk` protocol violation,
  invalid JSON on a 200 body, or a Durable Object HTTP 400 / 404 / 409) → non-retryable
  `INTERNAL_SERVER_ERROR`. An unclassified claim-store throw is also `INTERNAL_SERVER_ERROR`
  (fail loud; never quietly bucketed as retryable). Every claim-store catch classifies
  through the same seam — acknowledge / confirm / claim cannot hardcode a retryable code.

Holdover replays and non-live-Run resolutions never had tickets, so no redemption path exists
for them — the no-new-Exposure invariants of
[assignment-store-integration.md](./assignment-store-integration.md) hold structurally.

## Integrity properties (the attack-test contract)

These are the proofs the implementing slice must write, verbatim:

1. **Forgery**: a syntactically valid item whose ticket was not minted by the Worker (wrong MAC, or
   any payload field altered — Variant name, Run, Targeting Key hash) is rejected
   `EXPOSURE_TICKET_INVALID`. There is no code path from client-supplied fields to an Exposure row.
2. **Cross-tenant**: a valid App-B credential redeeming an App-A ticket is rejected; no row appends.
3. **Replay**: an exact `exposureId` retry returns `deduplicated` with no second row. Re-redeeming
   the same ticket under a fresh `exposureId` is also `deduplicated` (ticket-fingerprint claim;
   ADR-0048 amplification bound) — analysis denominators are unchanged under either path, and
   pipeline first-touch (ADR-0005) remains the analytical authority if a concurrent race dual-appends.
4. **Expiry**: an expired ticket is rejected loud, never silently dropped.
5. **No amplification**: max 25 items / 32 KiB per request; per-key WAF rate limits apply as on
   every Client Key surface (ADR-0034, ADR-0040 posture: fail closed on malformed identity, origin,
   and rate violations).

## Billing

Zero. Redemption is an Exposure side effect and "Exposure side effects consume zero extra"
(ADR-0033). The Evaluations were billed when `evaluate-all` resolved them.

## Error codes

Two additions to the canonical registry
([contracts/error-responses.md](../contracts/error-responses.md)):

| `code`                    | details                                       | Meaning                                                |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| `EXPOSURE_TICKET_INVALID` | `{ exposureId: string }`                      | MAC/tenant/shape verification failed; not retryable    |
| `EXPOSURE_TICKET_EXPIRED` | `{ exposureId: string, issuedAt: timestamp }` | Ticket older than TTL; refetch Precomputed Evaluations |

Batch-level errors reuse the existing codes (`UNAUTHORIZED`, `CREDENTIAL_REVOKED`,
`ORIGIN_NOT_ALLOWED`, `VALIDATION_ERROR`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`).
Per-item claim-store deterministic faults reuse `INTERNAL_SERVER_ERROR` (already in the
canonical registry) — do not invent a parallel code.

## Seam contract

- **Port:** `redeemExposures(credential, items) -> per-item results` — side effect: canonical
  Exposure seal + awaited Assignment Store holdover-write ownership (inline put attempt,
  durable outbox retry on failure), per accepted item
- **Left side:** the browser client's exposure queue ([browser-client.md](./browser-client.md));
  any SDK holding redeemable tickets
- **Right side:** Evaluation Worker (owner of the Exposure pipeline seam and Assignment Store
  orchestration — this route lives beside `evaluate`, not in Event Ingest, which owns only the
  strictly-defined Metric/Web Event families, ADR-0039/ADR-0042)
- **Failure contract:** batch gate failure → whole-request error envelope, zero rows; item
  failure → per-item `rejected` + code, siblings unaffected; transient item rejection
  (`SERVICE_UNAVAILABLE`) → SDK retries with the same `exposureId`; deterministic item
  rejection → SDK drops after a loud log; deletion cutoff → per-item `suppressed` (drop,
  not success); nothing is ever silently dropped (ADR-0036)

## Sources

- [ADR-0048](../../adr/0048-precomputed-evaluations-decouple-resolution-from-exposure-via-exposure-tickets.md) — tickets, redemption, deferred commit
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md), [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md), [ADR-0034](../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md), [ADR-0040](../../adr/0040-client-keys-can-write-public-event-ingest.md), [ADR-0044](../../adr/0044-entity-pseudonyms-remain-stable-under-routine-key-rotation.md)
- [exposure-accessor.md](./exposure-accessor.md) — canonical Exposure payload (pipeline-owned)
- [assignment-store-integration.md](./assignment-store-integration.md) — the write path this defers
