# Convex Exposure delivery: transactionally durable encounter, verified server ingest

A locally resolved Variant becomes an Exposure only when the top-level application mutation that
uses it commits. The Convex Component makes that fact durable locally in the same transaction, then
delivers it asynchronously to Splitch. Network delivery is not part of the application transaction.

## Atomic Exposure boundary

For a fresh live-Run Assignment, the component mutation performs one atomic unit:

1. Resolve with the current validated snapshot and local Assignment Store.
2. Claim the caller's `idempotencyKey` against the canonical Evaluation fingerprint.
3. Insert the local holdover with put-if-absent semantics.
4. Insert one retry-stable Exposure outbox row.
5. Schedule an immediate delivery Action.

All five operations join the caller's top-level mutation transaction. An uncaught error or caller
rollback commits none of them. Reusing an idempotency key with the same fingerprint returns the
original result and schedules no second row; different content fails `IDEMPOTENCY_KEY_CONFLICT`.

The outbox row records the resolved Convex commit timestamp through `db.vars.commitTs`. That value is
the encounter time because it is the first point at which the application behavior and Exposure both
exist durably.

## Private outbox shape

```text
ConvexExposureOutbox {
  exposureId
  installationId
  evaluationFingerprint
  flagKey
  experimentId
  runId
  runConfigHash
  idType
  targetingKeyHash
  targetingKey
  attributes
  variantName
  exposedAtCommitTs
  state: pending | delivering | accepted | terminal | suppressed
  attemptCount
  nextAttemptAt
  lastError
}
```

`targetingKeyHash` is the component-local
`HMAC(componentIdentityKey, idType + ":" + targetingKey)` used by the local holdover store. The named
component instance supplies App scope, so an index on `(idType, targetingKeyHash, state)` is the
targeted deletion selector. It is never sent as the server's `targeting_key_hash` and never crosses
the trust boundary. One-Entity deletion derives the same selector, marks only matching pending or
delivering rows `suppressed`, and then purges them in bounded batches. A scheduled Action must
re-read state before sending, so an already claimed row cannot escape suppression.

The raw Targeting Key and attributes exist only in the customer's isolated component outbox while
delivery can still succeed. They never enter logs. Acceptance deletes the payload row immediately.
A permanent rejection or 24 hours without acceptance moves the row to `terminal`, emits a loud
integration-health failure, deletes raw identity/context and the local hash, and retains only the
non-identifying evaluation fingerprint, typed error code, timestamps, and bounded allowlisted error
envelope for 30 days.

## Server Exposure endpoint

```text
POST /api/sdk/server-exposures
Authorization: Bearer <apiKey>
Content-Type: application/json

{ exposures: ServerExposureItem[] } // non-empty, max 25 items and 32 KiB UTF-8 JSON
```

Each item contains `exposureId`, `installationId`, `flagKey`, `experimentId`, `runId`,
`runConfigHash`, `idType`, `targetingKey`, complete `attributes`, `variantName`, and `exposureAt`, the
millisecond UTC conversion of the Convex commit timestamp. The API Key supplies App and Environment
scope; the body cannot select either. The endpoint is unavailable to Client Keys and never accepts a
`targeting_key_hash` from the caller.

The response is an ordered per-item result using `accepted`, `deduplicated`, or `rejected`.
Whole-batch authentication, shape, body-size, item-cap, and abuse failures reject the batch before
any claim. Item claims use `exposureId`: an exact retry is `deduplicated`, while reuse with a
different canonical fingerprint is `EVENT_ID_CONFLICT`.

A rejected item includes `retryable`. `SERVICE_UNAVAILABLE` sets it to `true`, keeps the unchanged
outbox payload pending, and follows the retry schedule below even when the outer response is `2xx`.
All deterministic item failures set it to `false` and become terminal. Missing or revoked
installation state is terminal `CONVEX_INSTALLATION_NOT_FOUND`; it is not availability failure.

## Verification before acceptance

For each new item the Evaluation Worker:

1. Verifies the active installation and loads the immutable Run, then verifies App, Environment,
   Experiment, and Flag ownership.
2. Requires the submitted `runConfigHash` to equal the frozen Run `configHash`.
3. Requires `exposureAt` to fall inside the Run's live interval and the endpoint's bounded clock
   and delivery window.
4. Validates `idType` and the complete Evaluation Context against the frozen Run.
5. Recomputes the Variant with the shared evaluator, using the Run's frozen Control Variant when no
   Run Targeting Rule matches.
6. Rejects a mismatched Variant, Run, config hash, or timestamp and seals nothing.
7. Derives `targeting_key_hash` with the App Entity identity key.
8. Atomically seals the retry-stable canonical Exposure and its claim in Event Ingest.
9. Starts the normal Assignment Store holdover write after durable acceptance.

The endpoint does not trust the component to mint Exposure Tickets and does not expose the ticket
HMAC key. A bounded `exposureAt` window accepts delayed outbox delivery but rejects a future time or
an encounter older than 24 hours.

## Canonical time and pipeline behavior

The canonical Exposure row gains required `exposure_at`:

- remote `evaluate` and Exposure Ticket redemption set it to `server_received_at`
- verified Convex delivery sets it to the bounded Convex commit timestamp
- `server_received_at` records when Splitch accepted the request
- `ingest_ts` records when Tinybird inserted the row
- `client_timestamp` remains optional diagnostics and is never an alias for `exposure_at`

First-touch chooses `MIN(exposure_at)`. Conversion Windows and Activation ordering use the resulting
`first_exposure_ts`. Existing rows are backfilled or projected with
`exposure_at = server_received_at` before consumers switch, so no retained row becomes null and no
historical first-touch order changes.

## Retry, health, and privacy

The scheduled Action claims one pending row, posts with the API Key, and acknowledges it in a
follow-up mutation. Transient transport, `429`, and `5xx` failures reschedule with the same
`exposureId` after `1s`, `5s`, `30s`, `2m`, `10m`, then `30m` with up to 20% jitter on every capped
retry. Convex does not automatically retry failed Actions, so the outbox state is the authority.
Deterministic rejection becomes terminal immediately. Transport errors, `429`, `5xx`, and a
successful batch item carrying retryable `SERVICE_UNAVAILABLE` reschedule unchanged. Transient
retries stop at the 24-hour privacy deadline and become terminal after raw identity/context is
removed.

Integration health exposes oldest pending age, pending count, terminal count, last accepted time,
and the complete latest bounded allowlisted error envelope without Targeting Key or attribute
values. App/Entity deletion and component uninstall suppress delivery first, then purge matching
pending rows and local holdovers.

## Non-goals

- Exactly-once network delivery. Retry-stable IDs and authoritative server claims make at-least-once
  delivery safe.
- Accepting server Exposures through a Client Key or trusting caller-supplied hashes and Variants.
- Replacing Metric Event, Web Event, or Activation timestamps with the Convex commit timestamp.
- Sending an Exposure from a Convex query or before the application mutation commits.

## Done

- Tests prove top-level rollback leaves no holdover, outbox, scheduled delivery, or Splitch Exposure.
- Retry, concurrent first use, exact duplicate, conflicting duplicate, and permanent rejection are
  proven against the real component and Worker boundaries, not only fakes.
- Tinybird fixtures prove delayed Convex delivery uses commit-time `exposure_at`, preserves existing
  rows, and keeps one first-touch denominator and Conversion Window anchor.
- Preview proof runs a real Experiment through Convex mutation Evaluation, Exposure acceptance,
  Metric Event ingestion, results, retry dedup, and cleanup.

## Sources

- [ADR-0049](../../adr/0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)
- [Convex commit timestamps](https://docs.convex.dev/database/advanced/commit-timestamp)
- [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)
- [exposure-event-contract.md](../pipeline/exposure-event-contract.md)
- [exposures-endpoint.md](./exposures-endpoint.md), [assignment-store-integration.md](./assignment-store-integration.md)
