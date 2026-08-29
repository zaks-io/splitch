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
- remote Evaluation commit idempotency is scoped to Organization, App, Environment, the admitted
  App identity version, and the caller's key, so a replacement identity cannot replay a destroyed
  generation's redacted commit;
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
store. Late-arriving events with an earlier `exposure_at` than previously seen rows are handled
correctly on the next dedup query run (replayability, ADR-0010).

## SDK seen-set is not authoritative

The SDK maintains a per-`(experiment_id, run_id)` seen-set as a **hot-path optimization** to avoid redundant wire calls. This set is per-node and per-runtime; it is NOT the dedup authority. An Entity hitting two POPs produces two raw rows even if both SDK instances have seen it — that is the correct input to the ELT deduper. The seen-set is reset at Run boundaries so a new Run correctly lets a fresh Exposure fire.

## Timestamp sourcing

| Field                | Source                                                   | Use                                                             |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `exposure_at`        | Splitch receive time, or verified trusted adapter commit | Canonical encounter time for first-touch and Conversion Windows |
| `server_received_at` | Evaluation Worker's durable-acceptance time              | Delivery diagnostics and retention                              |
| `ingest_ts`          | Tinybird insertion time (`DEFAULT now64(3)`)             | Snapshot/tail watermark only; never used for analysis ordering  |
| `client_timestamp`   | SDK payload from the client runtime                      | Diagnostics only; never used for ordering                       |

`exposure_at` and `server_received_at` are sealed in the canonical payload. Ordinary Evaluation and
ticket redemption set them to the same Splitch timestamp. The API-Key-only trusted-adapter endpoint
may set `exposure_at` from a bounded, recomputed server commit while Splitch stamps
`server_received_at`. The producer omits `ingest_ts`; Tinybird populates it when the Events API
inserts the physical row. `client_timestamp` is optional; if absent,
diagnostics degrade gracefully. Never use `client_timestamp` for first-touch ordering (clock skew
vulnerability). Never use `ingest_ts` for first-touch ordering either; it exists only so the physical
snapshot/tail layer can safely catch late Queue delivery and manual replay.

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

Multiple POPs may fire an Exposure for the same Entity in the same Run within a short window (e.g., CDN routing change). This produces multiple `raw_events` rows with different `source_id` values and potentially slightly different `exposure_at` values. The dedup query picks `MIN(exposure_at)` — the earliest encounter wins as first-touch. The DO's `putIfAbsent` is called by whichever POP fires the Exposure, and the first DO writer wins (ADR-0009).

**Note on experience/analysis divergence:** The DO first-touch winner (experience) and the dedup query first-touch winner (analysis) may not be the same POP if their `exposure_at` values differ by milliseconds. This is accepted — the divergence is cosmetic and self-healing, bounded to the ~60s KV propagation window. Variant assignment is deterministic, so any two POPs assign the same Variant to the same `(run_id, Targeting Key)` pair (ADR-0001).

## Holdover write trigger

On apparent first-touch (the Evaluation Worker has no KV entry for this
`(experiment_id, id_type, targeting_key_hash)`), Exposure-pipeline orchestration hosted by that Worker
MUST call `AssignmentStore.put()`. Its DO adapter implements `DO.putIfAbsent` (ADR-0009). The
sequencing:

1. Evaluate the flag → produce `(run_id, variant)` from `assign()` or KV replay.
2. Synchronously hand the raw Exposure row to the Event Ingest Worker and wait only until its scoped
   Evaluation idempotency claim, resolved-result fingerprint, retry-stable row, and delivery payload
   are sealed atomically in the durable `raw_events` outbox. The request handler never waits for Queue
   publication or Tinybird. This step is skipped on a holdover replay because a holdover fires no
   Exposure (see
   [evaluation/exposure-firing-and-accessor.md](../evaluation/exposure-firing-and-accessor.md)
   §Holdover path).
3. Return the Variant only after step 2 succeeds.
4. If no KV entry was found: asynchronously call `AssignmentStore.put(key, run_id, variant)`;
   the DO adapter executes `DO.putIfAbsent` with a short timeout.

The durable Exposure seal is the analysis acceptance boundary and is on the response path; Queue and
Tinybird delivery remain asynchronous. If the seal fails, evaluation fails loud, no Assignment Store
write begins, and a client retry reuses the same Evaluation idempotency key. The DO write remains
non-blocking after acceptance: it executes with a short timeout (~100ms) and does not delay the
response. A DO write failure is a holdover miss only for the KV propagation window; `assign()` remains
deterministic on retry.

## Ingest failure contract

| Failure                                                  | Effect                                                         | Recovery                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Durable Exposure outbox seal fails before response       | Evaluation fails loud; no Assignment Store write begins        | Retry the same Evaluation idempotency key                                      |
| Queue publication fails after durable outbox seal        | Accepted rows remain unavailable to analysis until publication | Durable outbox retries Queue publication                                       |
| Retryable Tinybird `429`/`500`/`503` after queue handoff | Accepted rows remain unavailable to analysis until redelivery  | Bounded queue retry with stable per-row dedup keys                             |
| Tinybird `422` materialized-view interruption            | Raw and derived commit status is indeterminate                 | Durable reconciliation record; no ordinary retry                               |
| Permanent Tinybird failure or quarantined rows           | Affected delivery leaves the primary queue                     | Durable datasource DLQ copy plus critical alert; manual replay only            |
| DO write fails after durable outbox seal                 | Holdover miss for up to ~60s + retry window                    | `assign()` is deterministic — same Variant computed on miss; DO retry picks up |
| KV write-through from DO fails                           | KV miss for ~60s                                               | Next KV read recomputes and re-propagates via DO (self-healing)                |

There is no distributed transaction across Tinybird + DO + KV. DO and KV propagation failures are
cosmetic and self-healing within the ~60s propagation window. Ingest failures are different:
retryable delivery remains unavailable until queue redelivery succeeds, and permanent or quarantined
delivery remains unavailable until an operator completes manual DLQ replay. Indeterminate `422`
delivery remains blocked until scoped reconciliation proves or repairs its state. Accepted delivery
lag, reconciliation backlog, and DLQ backlog are visible operational failures, never described as
self-healing.

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
Before sending, it persists one write-ahead delivery attempt for each resulting bounded request, then
sends gzip-compressed NDJSON to
`/v0/events?name={datasource}&wait=true`. It acknowledges the queue delivery only after Tinybird
confirms a complete `200` commit or after a `422` is durably transferred to indeterminate
reconciliation.

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

### Write-ahead delivery attempts

Before each Tinybird request, the consumer atomically persists a record in the durable recovery store
keyed by datasource and attempt ID, plus a one-to-many index from every source queue message ID to its
attempt IDs. It contains `state = 'attempting'`, the exact row references,
App/Environment/date scopes, retry-stable `dedup_key` values, payload fingerprints, and attempt count.
If that transaction fails, the consumer does not call Tinybird. Redelivery checks the message-ID index
before preparing any request, even when only a subset of the original messages returns. A queue
message is acknowledged only after every indexed split request containing one of its rows reaches a
terminal `delivered`, `indeterminate`, or `poison_transferred` state.

Response handling transitions the same record before queue acknowledgement or retry:

- a complete `200` becomes `delivered`; redelivery skips Tinybird and resumes acknowledgement;
- `422` becomes `indeterminate` and enters scoped reconciliation;
- `429`, `500`, `503`, or HTTP/2 `GOAWAY` becomes `retryable` with the next permitted attempt time;
  `GOAWAY` also recreates the connection. Before another request, the consumer atomically increments
  the attempt count and returns the record to `attempting`;
- a permanent response becomes nonterminal `poison_pending`; and
- a response-transition failure leaves `state = 'attempting'`.

Redelivery that finds `attempting`, `indeterminate`, `delivered`, `poison_pending`, or
`poison_transferred` never calls Tinybird. An unresolved `attempting` record is treated as an unknown
outcome and reconciled by the same bounded App/Environment/date/key procedure as `422`.
`poison_pending` resumes DLQ copy, while `poison_transferred` resumes acknowledgement. Only an explicit
`retryable` record may generate another Tinybird request. This guard makes a failed post-response state
write conservative without turning recovery-store failure into a blind ingest loop.

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

On Tinybird `429`, `500`, or `503`, the consumer honors `Retry-After`, when present, before retrying
the unacknowledged delivery with exponential backoff and jitter. HTTP/2 `GOAWAY` recreates the
connection before retry. Pre-response network failures use the same bounded path after their
write-ahead attempt is classified. The consumer records Tinybird rate-limit headers, retry count,
queue depth, and oldest-message age. Growing age alerts operators but never relaxes the governor.

### Poison delivery and dead-letter isolation

Each primary datasource queue has one matching dead-letter queue. The consumer classifies these as
permanent delivery failures:

- a Tinybird success response with `quarantined_rows > 0`;
- `successful_rows` not matching the number of rows sent;
- a non-retryable Tinybird HTTP response other than `422`.

For a permanent failure, the consumer transitions the write-ahead attempt to nonterminal
`poison_pending`, then copies the original delivery messages plus bounded sanitized failure metadata
to that datasource's dead-letter queue. A redelivery that finds `poison_pending` skips Tinybird and
resumes the DLQ transfer. Only after the DLQ copy succeeds does the consumer transition the attempt to
terminal `poison_transferred` and acknowledge the primary messages. A redelivery that finds
`poison_transferred` only resumes acknowledgement. The consumer emits a critical alert containing the
datasource, row count, response class, and request correlation ID, but no event fields, Dimensions,
identity, or request body.

After `poison_pending` is durable, the consumer does not resubmit the permanent failure, recursively
split its rows, or replay individual rows to identify a poison item. Tinybird may already have
committed valid siblings, so probing would create duplicate physical rows and unnecessary ingest
load. If the poison transition fails after the Tinybird response, the write-ahead record remains
`attempting`; redelivery reconciles it without resubmission. Dead-letter replay is an explicit
operator action, preserves each original row and `dedup_key`, and rechecks current privacy deletion
suppression before publication.

Tinybird `429`, `500`, `503`, and classified pre-response network failures are retryable. A delivery
receives at most eight total attempts, including the initial attempt. Exhaustion follows the same
state machine as a permanent response: transition to `poison_pending`, copy the original messages to
the datasource's dead-letter queue, transition to `poison_transferred` only after that copy succeeds,
then acknowledge the primary messages and emit the same critical alert. Cloudflare consumer
configuration therefore uses `max_retries = 7`.

### Indeterminate materialized-view interruption

Tinybird `422` means a materialized view interrupted ingestion and does not prove whether each raw or
derived row committed. Retrying can duplicate raw rows; acknowledging without durable follow-up can
lose a row. The consumer therefore never sends a `422` through ordinary retry or poison transfer.
The consumer transitions the existing write-ahead attempt from `attempting` to `indeterminate` before
acknowledging the primary messages. If that transition fails, the record remains `attempting`, so
redelivery reconciles instead of calling Tinybird. The recovery store cannot clear referenced
payloads while either state is unresolved.

The reconciliation worker waits for the Tinybird request to settle, then queries the raw datasource
and any expected materialized target by recorded App, Environment, date, and retry keys:

1. raw rows and expected states present marks the delivery complete;
2. raw rows present but states absent runs a bounded state populate from raw truth and reconciles it;
3. raw rows absent permits operator-reviewed replay only after repeated scoped reads confirm absence;
4. mixed or unresolved evidence remains blocked and alerted without Tinybird replay.

App and Entity deletion suppression applies to these records and their referenced payloads before
reconciliation or replay. Reconciliation completion is auditable and only then removes the record.

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

The Evaluation Worker returns a Variant only after Event Ingest seals the raw Exposure row in its
durable outbox. Admission rejection or outbox failure therefore fails the Evaluation before an
Assignment Store write begins. Queue publication and Tinybird delivery remain asynchronous after
that boundary; a successful response cannot depend on the SDK re-firing an Exposure.

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

The Evaluation Worker likewise waits for the scoped claim, result fingerprint, retry-stable Exposure
row, and payload to be sealed atomically in the `raw_events` outbox before returning its Variant; it
does not wait for Queue or Tinybird. Other intake returns an accepted response only after its
canonical delivery payload is durably sealed in an equivalent outbox or accepted by Cloudflare Queue.
The queue consumer then uses `wait=true` and
acknowledges its queue messages after a complete `200` commit acknowledgement or after a `422` is
durably transferred to indeterminate reconciliation. Tinybird latency and retries never extend the
public SDK request beyond the durable acceptance boundary.

## Non-exposing paths

Peek (`sdk.peekVariant`) and test-evaluation (ADR-0026) MUST NOT call the ingest endpoint. These are structurally separate code paths — no "suppression flag" on a shared ingest call.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md) — expose-on-read, peek as distinct accessor
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md) — SDK seen-set is not authoritative
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md) — DO write trigger, KV propagation window, failure modes
- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — at-least-once, no global ordering
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — Tinybird physical ingest
- [ADR-0043](../../adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md) — accepted queue microbatch target and current direct-write debt
