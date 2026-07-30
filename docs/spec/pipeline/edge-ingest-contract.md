# Event ingest contract: edge Workers to append-only logs

Evaluation Worker instances produce Exposure events and hand them to the Event Ingest Worker for
durable queue-backed delivery to the append-only `raw_events` log in Tinybird. This contract governs
the delivery guarantees, idempotency, timestamp handling, and the interaction with the Assignment
Store write on apparent first-touch.

## Implementation status

The queue-backed contract in this document is the accepted target from
[ADR-0043](../../adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md), not
the current implementation.

In the current checkout:

- `raw_events` and `raw_evaluations` are implemented;
- each implemented row is sent in its own JSON request by
  `apps/event-ingest-api/src/tinybird.ts`;
- an Evaluation commit loops over Exposure rows and appends them sequentially;
- `apps/event-ingest-api/wrangler.jsonc` declares no Cloudflare Queue producer or consumer binding;
- Metric Event and Web Event intake are specified but not implemented.

That direct transport is known architecture debt. It must be replaced, not extended to the new event
families.

The Event Ingest Worker also accepts SDK Metric Events through `POST /api/sdk/events` and appends
them to the separate `metric_events` datasource. Its strict request, identity, Event Definition
version, idempotency, and no-write contract is
[metric-event-contract.md](./metric-event-contract.md).

The same Worker accepts Web Events through the distinct `POST /api/sdk/web-events` route and appends
them only to `web_events`. The route accepts only a non-empty `{ events: [...] }` batch envelope,
including for one event, with at most 25 items and a 32 KiB UTF-8 body. Each Web Event item has a
separate strict request schema and family-scoped retry claim; Web Events do not use the Exposure or
Metric Event envelope. Their capture and identity boundaries are defined in
[web-analytics-capture.md](../sdk/web-analytics-capture.md) and
[web-event-identity.md](./web-event-identity.md).
Neither Metric Events nor Web Events use the Exposure first-touch or Assignment Store paths below.
Web Event ingest does not sample or thin a valid batch. The existing Client Key rate limit rejects
the complete batch with `RATE_LIMITED` before any claim or row is written.

## Delivery guarantee

**At-least-once, never exactly-once.** The same physical Exposure (one Entity, one Variant, one moment) may produce multiple rows in `raw_events` — this is intentional (ADR-0004, ADR-0010). The dedup query is authoritative; the raw log is the system of record.

Each POP emits independently. There is no global ordering requirement and no global edge dedup
store. Late-arriving events with an earlier `server_received_at` than previously seen rows are handled
correctly on the next dedup query run (replayability, ADR-0010).

## SDK seen-set is not authoritative

The SDK maintains a per-`(experiment_id, run_id)` seen-set as a **hot-path optimization** to avoid redundant wire calls. This set is per-node and per-runtime; it is NOT the dedup authority. An Entity hitting two POPs produces two raw rows even if both SDK instances have seen it — that is the correct input to the ELT deduper. The seen-set is reset at Run boundaries so a new Run correctly lets a fresh Exposure fire.

## Timestamp sourcing

| Field                | Source                                                   | Use                                                             |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `server_received_at` | Evaluation Worker's `Date.now()` when the Exposure fires | Canonical for `MIN(ts)` first-touch ordering in the dedup query |
| `ingest_ts`          | Raw-log append / collector receive time                  | Snapshot/tail watermark only; never used for analysis ordering  |
| `client_timestamp`   | SDK payload from the client runtime                      | Diagnostics only; never used for ordering                       |

`server_received_at` and `ingest_ts` are always populated. `client_timestamp` is optional — if absent,
diagnostics degrade gracefully. Never use `client_timestamp` for first-touch ordering (clock skew
vulnerability). Never use `ingest_ts` for first-touch ordering either; it exists only so the
physical snapshot/tail layer can safely catch late-arriving rows.

## `run_id` stamping

`run_id` is stamped at **SDK fire-time** from the live Run config the Evaluation Worker read from
KV. The Evaluation Worker does not fetch `run_id` from a separate source at ingest time. If the KV
config is stale by up to ~60s (ADR-0009 propagation window), the Exposure is stamped with the Run
the Evaluation Worker knew about. This is accepted and self-healing.

## `id_type` sourcing

`id_type` is read from the request's required `idType` field, then validated against the live Run
config in KV before Assignment Store lookup, Exposure logging, or DO writes. The Run config is the
authority; the request is the candidate value. A mismatch returns `400 VALIDATION_ERROR`.

After validation, the Evaluation Worker stamps the validated `id_type` and derives
`targeting_key_hash` server-side. This keeps the Assignment Store DO key
`(experiment_id, id_type, targeting_key_hash)` consistent with the Experiment's declared Entity type
while still making cross-Entity-type collisions fail loud at the SDK boundary.

## `app_id` injection

`app_id` is injected by the Evaluation Worker from the authenticated credential context (Client Key
or API Key binding). Never sourced from the client payload. This is the data-isolation guarantee
(ADR-0018).

## Cross-POP duplication

Multiple POPs may fire an Exposure for the same Entity in the same Run within a short window (e.g., CDN routing change). This produces multiple `raw_events` rows with different `source_id` values and potentially slightly different `server_received_at` values. The dedup query picks `MIN(server_received_at)` — the earliest server-received-at row wins as first-touch. The DO's `putIfAbsent` is called by whichever POP fires the Exposure, and the first DO writer wins (ADR-0009).

**Note on experience/analysis divergence:** The DO first-touch winner (experience) and the dedup query first-touch winner (analysis) may not be the same POP if their `server_received_at` values differ by milliseconds. This is accepted — the divergence is cosmetic and self-healing, bounded to the ~60s KV propagation window. Variant assignment is deterministic, so any two POPs assign the same Variant to the same `(run_id, Targeting Key)` pair (ADR-0001).

## Holdover write trigger

On apparent first-touch (the Evaluation Worker has no KV entry for this
`(experiment_id, id_type, targeting_key_hash)`), the Evaluation Worker MUST call `DO.putIfAbsent` for the
Assignment Store (ADR-0009). The sequencing:

1. Evaluate the flag → produce `(run_id, variant)` from `assign()` or KV replay.
2. Hand the raw Exposure row to the Event Ingest Worker for durable queue-backed `raw_events`
   delivery. The request handler never posts the row directly to Tinybird. This step is skipped on a
   holdover replay because a holdover fires no Exposure (see
   [evaluation/exposure-firing-and-accessor.md](../evaluation/exposure-firing-and-accessor.md)
   §Holdover path).
3. If no KV entry was found: call `DO.putIfAbsent(key, run_id, variant)` asynchronously (fire-and-forget with short timeout).

The DO write is **non-blocking on the hot path** — it executes with a short timeout (~100ms) and does not delay the response to the SDK caller. If the DO write times out or fails, it is retried asynchronously. A DO write failure is a holdover miss only for the KV propagation window; because `assign()` is deterministic (ADR-0001), the Entity gets the same Variant on the next evaluate even without the holdover. No distributed transaction — experience (DO) and analysis (log) each self-correct.

## Ingest failure contract

| Failure                                                   | Effect                                                        | Recovery                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Durable queue handoff fails                               | Raw row is not accepted for delivery                          | Retry the handoff at-least-once; SDK may re-fire on a later evaluate           |
| Retryable Tinybird microbatch failure after queue handoff | Accepted rows remain unavailable to analysis until redelivery | Bounded queue retry with stable per-row dedup keys                             |
| Permanent Tinybird failure or quarantined rows            | Affected delivery leaves the primary queue                    | Durable datasource DLQ copy plus critical alert; manual replay only            |
| DO write fails after queue handoff                        | Holdover miss for up to ~60s + retry window                   | `assign()` is deterministic — same Variant computed on miss; DO retry picks up |
| KV write-through from DO fails                            | KV miss for ~60s                                              | Next KV read recomputes and re-propagates via DO (self-healing)                |

There is no distributed transaction across Tinybird + DO + KV. The failure modes are cosmetic and self-healing within the ~60s KV propagation window.

## Queue-backed Tinybird microbatch transport

Every Tinybird-backed event stream owned by the Event Ingest Worker uses the same transport pattern
with one dedicated durable Cloudflare Queue per destination:

- `raw_events` for Exposures and Activations;
- `raw_evaluations` for Evaluation usage;
- `metric_events` for Metric Events;
- `web_events` for Web Events.

An HTTP intake handler validates and stamps canonical rows, then hands accepted delivery units to
that datasource's queue. It never calls the Tinybird Events API directly. A queue consumer combines
all rows from up to 100 delivered queue messages or one second of queue wait, whichever comes first.
It sends those rows as one gzip-compressed NDJSON request to
`/v0/events?name={datasource}&wait=true` and acknowledges the queue delivery only after Tinybird
confirms the database commit.

No queue or delivery message mixes datasources. A consumer never fans a multi-row delivery unit or
consumer batch into one request per row. A timeout-flushed microbatch may contain one row only when
no other row arrived during its queue wait. The uncompressed NDJSON request-body ceiling is 5 MiB.
If a serialized consumer batch would exceed it, the consumer splits it into the fewest bounded
NDJSON requests that preserve row boundaries and sends those requests sequentially; it still does
not fall back to a row-by-row loop.

A Queue message is a bounded datasource-specific delivery unit and may carry one or more canonical
rows. Producer message granularity is not the Tinybird import granularity: the consumer flattens
rows from all delivered messages into the fewest bounded NDJSON requests. This permits an
independently sealed Metric or Web Event to publish safely without turning that event into one
Tinybird HTTP request.

Every serialized Queue message, including its Splitch delivery envelope, is at most 120,000 bytes.
This stays below Cloudflare Queues' 128 KB message limit and leaves room for platform metadata.
Before acceptance, Event Ingest proves every canonical row fits in a one-row message; an external
oversized event fails its family request bound, and an oversized internal row fails loud before
durable acceptance. Producers greedily pack multiple rows only while the message remains within
120,000 bytes. `sendBatch` calls contain at most 100 messages and at most 240,000 total serialized
bytes; larger publication sets are split across calls. Splitting Queue publication does not split a
claim or change the consumer's cross-message Tinybird microbatching.

### Fixed drain governor

Every datasource queue uses these checked-in consumer settings:

```text
max_concurrency = 1
max_batch_size = 100
max_batch_timeout = 1 second
```

`max_concurrency = 1` is a Tinybird protection boundary: at most one request for that datasource may
be in flight, including when a consumer batch is split by the 5 MiB body ceiling. Queue backlog,
message age, or producer rate never increases this value automatically. Capacity changes require an
explicit reviewed configuration change backed by observed Tinybird ingestion capacity.

On Tinybird `429`, the consumer honors `Retry-After` before retrying the unacknowledged delivery.
Any Tinybird `5xx` and network failure retries with exponential backoff and jitter. The consumer
records Tinybird rate-limit headers, retry count, queue depth, and oldest-message age. Growing age
alerts operators but never relaxes the governor.

### Poison delivery and dead-letter isolation

Each primary datasource queue has one matching dead-letter queue. The consumer classifies these as
permanent delivery failures:

- a Tinybird success response with `quarantined_rows > 0`;
- `successful_rows` not matching the number of rows sent;
- a non-retryable Tinybird HTTP response.

For a permanent failure, the consumer copies the original delivery messages plus bounded sanitized
failure metadata to that datasource's dead-letter queue. Before the first copy attempt, it writes a
durable poison-transfer marker keyed by datasource and the sorted primary message IDs. A redelivery
that finds that marker skips Tinybird and resumes the DLQ transfer. Only after the DLQ copy succeeds
does the consumer acknowledge the primary messages and clear the marker. It emits a critical alert
containing the datasource, row count, response class, and request correlation ID, but no event
fields, Dimensions, identity, or request body.

After the poison-transfer marker is durable, the consumer does not resubmit the permanent failure,
recursively split its rows, or replay individual rows to identify a poison item. Tinybird may already
have committed valid siblings, so probing would create duplicate physical rows and unnecessary
ingest load. If the marker write itself fails after the Tinybird response, at-least-once redelivery
may resubmit the original messages; stable dedup keys preserve logical idempotency and the failure is
alerted. Dead-letter replay is an explicit operator action, preserves each original row and
`dedup_key`, and rechecks current privacy deletion suppression before publication.

Tinybird `429`, any `5xx`, and network failures are retryable. A delivery receives at most eight
total attempts, including the initial attempt. Exhaustion moves the original messages to the
datasource's dead-letter queue and emits the same critical alert. Cloudflare consumer configuration
therefore uses `max_retries = 7`.

### Admission before buffering

The queue absorbs valid traffic spikes and Tinybird outages; it does not absorb arbitrary
unvalidated client data. Authentication, authorization, origin policy, strict outer-envelope and
per-item schema validation, Event Definition resolution, body and item bounds, idempotency, and
per-credential rate limits run before queue publication. Invalid or undeclared input never consumes
queue storage or Tinybird ingest capacity.

After validation and idempotency lookup identify the canonical new rows, an Event Ingest-owned
Ingest Admission Gate charges aggregate capacity under:

```text
(app_id, environment_id, ingest_stream)
```

`ingest_stream` is exactly one destination datasource: `raw_events`, `raw_evaluations`,
`metric_events`, or `web_events`. It is not the Event Definition `family`, whose domain enum remains
only `metric | web`.

The gate is one SQLite-backed `IngestAdmissionGateDurableObject` instance per scope. Event Ingest
derives the object with `idFromName(JSON.stringify([app_id, environment_id, ingest_stream]))`, so all
callers and Cloudflare locations for the same tuple coordinate through one object while unrelated
tuples remain independently sharded. The Worker must not use one global Admission Gate object or
reuse the event-id deduplication and durable outbox shards for aggregate admission.

The gate charges both the number of new canonical rows and their serialized queue-payload bytes.
HTTP request count is not the unit, so SDK batching cannot bypass the limit. Exact idempotent retries
and duplicate Web Event items that require no new queue publication consume zero aggregate capacity.
The standard per-credential limiter still runs independently; a request must pass both controls.

That zero-cost rule applies after an existing claim is observed. Concurrent attempts can both
observe no claim before one wins the family-scoped claim transaction, so they may conservatively
consume admission capacity more than once while still producing only one logical row. Admission
tokens are not refunded or deduplicated across Durable Objects; tests must preserve this documented
upper-bound behavior rather than promise exact accounting under races.

For a Web Event batch, side-effect-free item validation and existing-claim lookup first classify
items as rejected, duplicate, or new. One Admission Gate call charges the total count and bytes of
the new set. Gate failure rejects the complete request before new claims or outbox writes; it does
not return a partial `202` response. After admission passes, valid new siblings retain independent
claim and result semantics.

Each object owns exactly two token buckets: rows and serialized queue-payload bytes. An admission
request supplies both non-negative costs. The object uses its own current time to refill both
buckets and performs both deductions in one SQLite storage transaction. It returns
`{ allowed, retryAfterMs }`; both deductions commit when allowed, and neither bucket changes when
either cost cannot be admitted. A zero-row, zero-byte exact replay is allowed without consuming
tokens.

If either aggregate budget is unavailable, the Event Ingest Worker rejects the complete request with
`429 RATE_LIMITED` and canonical `Retry-After` before any new claim, outbox write, or queue
publication. A Web Event batch does not partially admit otherwise valid siblings when this
batch-level gate fails. A missing or failed Admission Gate fails closed.

Accepted valid rows are never sampled, thinned, or silently dropped to protect Tinybird. When input
temporarily exceeds safe Tinybird drain capacity, queue backlog and freshness lag grow while each
datasource remains isolated. The system alerts on that lag rather than automatically allowing one
queue to increase Tinybird pressure or consume another datasource's delivery capacity.

An Evaluation response returned before its background raw-event handoff is not an Event Ingest
acceptance. A later Admission Gate rejection or failed handoff is recorded through the fail-loud
ingest error path and may leave that Exposure unavailable to analysis, as defined in
[holdover-write-contract.md](./holdover-write-contract.md). The no-silent-drop guarantee begins
after Event Ingest has durably accepted a row.

Admission count and byte budgets are operational fairness controls. They consume no V1 billing unit,
do not alter the Organization Evaluation quota, and are not customer-configurable spend guards.

The checked-in admission configuration has this shape:

```typescript
type IngestAdmissionBudget = {
  rowsPerSecond: number;
  rowBurstCapacity: number;
  bytesPerSecond: number;
  byteBurstCapacity: number;
};
```

Every deployed target begins with this launch profile:

| `ingest_stream`   | `rowsPerSecond` | `rowBurstCapacity` | `bytesPerSecond` | `byteBurstCapacity` |
| ----------------- | --------------- | ------------------ | ---------------- | ------------------- |
| `raw_evaluations` | 250             | 2,500              | 262,144          | 2,621,440           |
| `raw_events`      | 300             | 3,000              | 524,288          | 5,242,880           |
| `metric_events`   | 100             | 1,000              | 524,288          | 5,242,880           |
| `web_events`      | 500             | 5,000              | 1,048,576        | 10,485,760          |

The burst capacities hold 10 seconds of refill. Byte units are binary bytes: `262,144` is 256 KiB,
`524,288` is 512 KiB, and `1,048,576` is 1 MiB. Row cost is the count of canonical new rows; byte
cost is the serialized queue-payload byte length for those rows.

These values are platform-owned checked-in configuration. There is no customer override, runtime
auto-tuning, or automatic backlog-based increase. A change requires reviewed load evidence showing
stable queue age, no sustained Tinybird `429` responses, and recovery after a 2x burst. A missing
stream or value fails closed.

Per-scope budgets can add up across Apps and Environments, so they are not a hard cap on aggregate
Tinybird traffic. The fixed per-datasource queue consumer governor remains that protection boundary.

The Tinybird append token is a secret binding on the Event Ingest Worker and has only datasource
append scope. The public SDK never receives that token and never writes directly to Tinybird.

### Durable acceptance boundary

`202 accepted` acknowledges durable ownership by Event Ingest, not a Tinybird commit. For
claim-backed Metric Events and Web Events, the family-scoped idempotency claim and canonical
delivery payload are sealed atomically in the durable ingest outbox before the response is returned.
The outbox retries Cloudflare Queue publication until it succeeds, so a committed claim cannot lose
its row between claim and queue handoff.

Other intake returns an accepted response only after its canonical delivery payload is durably
sealed in an equivalent outbox or accepted by Cloudflare Queue. The queue consumer then uses
`wait=true` and acknowledges its queue messages only after Tinybird confirms the datasource
microbatch commit. Tinybird latency and retries never extend the public SDK request.

## Non-exposing paths

Peek (`sdk.peekVariant`) and test-evaluation (ADR-0026) MUST NOT call the ingest endpoint. These are structurally separate code paths — no "suppression flag" on a shared ingest call.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md) — expose-on-read, peek as distinct accessor
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md) — SDK seen-set is not authoritative
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md) — DO write trigger, KV propagation window, failure modes
- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — at-least-once, no global ordering
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — Tinybird physical ingest
- [ADR-0043](../../adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md) — accepted queue microbatch target and current direct-write debt
