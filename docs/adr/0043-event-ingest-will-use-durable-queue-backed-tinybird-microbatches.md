# Event ingest will use durable queue-backed Tinybird microbatches

**Status:** accepted

**Implementation status:** partial. `metric_events` ships this decision: the Event Ingest Worker
consumes the `splitch-metric-events` queue under the fixed drain governor below, claims a write-ahead
delivery-attempt record on each row's Metric Event outbox object before any Tinybird call, sends one
bounded gzip NDJSON request per size split with `wait=true`, and transfers a poisoned row to the
dead-letter queue strictly before acknowledging it (SPL-447). `raw_events` and `raw_evaluations` still
send each row to Tinybird in its own JSON request, and Evaluation commits still loop over Exposure
rows sequentially; those datasources have no queue yet. Web Event intake is specified but not
implemented.

All Tinybird-backed ingest will be refactored onto four durable Cloudflare Queues owned and consumed
by the existing Event Ingest Worker: one queue each for `raw_events`, `raw_evaluations`,
`metric_events`, and `web_events`. Separate queues isolate datasource backpressure, retries, backlog,
and failures, so an unknown-quality Web Event spike cannot consume Exposure or Evaluation usage
delivery capacity. No intake handler may retain or add direct row-by-row Tinybird delivery.

Each queue consumer combines rows from up to 100 delivered queue messages or one second of queue
wait. Before each bounded Tinybird request, it persists a write-ahead delivery-attempt record plus a
source-message index in the same durable recovery store as poison-state records. Only then does it
send gzip-compressed NDJSON with `wait=true`. A redelivery that finds an unresolved attempt never calls
Tinybird again; it enters scoped reconciliation. The consumer acknowledges delivery after Tinybird confirms a complete commit,
or after a `422` has been durably transferred to indeterminate reconciliation. A timeout-flushed batch
may contain one row when traffic is sparse, but a multi-row delivery unit or consumer batch is never
fanned out into one request per row.

Each datasource queue has a fixed drain governor: `max_concurrency = 1`,
`max_batch_size = 100`, and `max_batch_timeout = 1` second. A consumer sends at most one Tinybird
request at a time and caps each uncompressed NDJSON request at 5 MiB. It sequentially splits an
oversized consumer batch at row boundaries. Queue depth never automatically increases consumer
concurrency. Tinybird `429`, `500`, and `503` responses honor `Retry-After`, when present, then retry
with exponential backoff and jitter. HTTP/2 `GOAWAY` recreates the connection before the same bounded
retry path; pre-response network failures use it as well. Growing oldest-message age alerts operators
instead of relaxing the governor.

Queue delivery envelopes are independently bounded to 120,000 serialized bytes, below Cloudflare's
128 KB message limit. Producers split Queue `sendBatch` calls at 100 messages or 240,000 aggregate
serialized bytes and prove each canonical row fits in one Queue message before durable acceptance.
The consumer may still combine rows from many messages into a Tinybird request or split that
combined set at the separate 5 MiB NDJSON ceiling.

The consumer runs at `max_concurrency: 5`. An invocation issues about one request per batch, so
five concurrent consumers sit near a third of the 100-requests-per-second-per-datasource ceiling even
when batches turn around quickly, and the remaining budget absorbs a backlog draining at full batch
size. Per-row settles inside an invocation run concurrently: each targets a different per-dedup-key
object and nothing orders them against each other, so awaiting them serially would reimpose the
per-row round trip the microbatch exists to remove.

A dead-letter queue receives two shapes and they are told apart by a `kind` field. This consumer
writes `metric-event-delivery-failure-v1`, carrying the original row beside its failure metadata.
Cloudflare writes the bare original message when a message exhausts `max_retries` outside the
transfer path, which is reachable for failures that never resolved a dedup key at all. A replay
consumer branches on `kind` and refuses an unrecognized shape rather than inferring one.

A response reporting quarantined rows or a short commit poisons its whole batch, including rows the
same response committed. Every column of `metric_events` is a `String` except the two `DateTime64`
timestamps this service generates, so tenant content cannot quarantine a row on its own and a
quarantine means the canonical row shape is wrong for every row like it, not for one tenant's. Rows
replayed from the dead-letter queue that had in fact committed collapse against their originals,
because `materialize_deduped_metric_events` groups by the retry-stable `dedup_key`. Identifying the
individual bad rows would take a second read against Tinybird's quarantine datasource on every
failure, which buys nothing against a fault that is systemic by construction.

Each datasource queue has its own dead-letter queue. A Tinybird success response with
`quarantined_rows > 0`, a committed row-count mismatch, or a permanent HTTP failure is never retried
through the ordinary transient path. The consumer transitions the existing write-ahead attempt to
nonterminal `poison_pending`, then copies the original delivery messages and failure metadata to that
datasource's dead-letter queue. After the copy succeeds it records terminal `poison_transferred`,
acknowledges the primary messages, and pages operators. Redelivery in either poison state skips
Tinybird; `poison_pending` resumes the DLQ transfer and `poison_transferred` resumes acknowledgement.
If the post-response state transition fails, the attempt remains `attempting`, and redelivery
re-sends it (see Stranded attempts below). The consumer does not recursively
split or replay the batch to discover a poison row because that would reinsert successful rows and add
Tinybird load. `429`,
`500`, `503`, and pre-response network failures receive at most eight total delivery attempts.
Exhaustion enters `poison_pending` and follows the same successful-DLQ-copy then
`poison_transferred` acknowledgement sequence as a permanent response. Replay is manual, preserves
every original per-row dedup key, and rechecks current privacy deletion suppression.

Stranded attempts re-send. A redelivery that finds `attempting` is by construction a later
invocation reading a claim whose owner never came back, so nothing ever recorded what Tinybird
answered. Treating that as indeterminate would park an event no reconciliation pass has any evidence
to resolve, and acknowledging it would drop the event with no record that it existed. Re-sending
risks a duplicate physical row instead, which costs nothing: `materialize_deduped_metric_events`
groups by the retry-stable `dedup_key` with `argMinState(..., ingest_ts)`, so
`serve_deduped_metric_events` already collapses retries of one logical event. Silent loss has no such
recovery. Distinguishing a claim stranded before dispatch from one stranded after the response would
take a second durable write per row between the Tinybird call and the settle, which is the per-row
round trip this ADR's microbatching exists to remove.

`attempting` therefore answers two different questions differently. A concurrent privacy deletion is
refused while a claim is open, because a live invocation may have that row in flight and redacting
would return a proof for a row that still lands. A redelivery reading the same state re-sends.

Tinybird `422` is a separate indeterminate outcome: a materialized view interrupted ingestion, so
blind retry can duplicate committed raw rows while acknowledging can lose uncommitted rows. The
write-ahead record already contains the datasource, attempt ID, sorted queue message IDs,
App/Environment/date scopes, every retry-stable `dedup_key`, and durable references to the canonical
outbox payloads. The consumer transitions it from `attempting` to `indeterminate` before acknowledging
the primary messages. If that transition fails, the record remains `attempting` and redelivery
re-sends it, because only a recorded `indeterminate` proves Tinybird answered at all. The recovery
store cannot clear referenced payloads while the record is unresolved. Reconciliation is the only path that can clear it:

1. raw rows and expected materialized states present means delivered;
2. raw rows present but states absent triggers a bounded state populate from raw truth, never a raw
   Events API replay;
3. raw rows absent permits operator-reviewed replay only after the Tinybird request is settled and
   repeated scoped reads confirm absence; and
4. mixed or unresolved evidence remains blocked and alerted.

The record is App- and Entity-deletion suppressible just like outbox, queue, poison, and DLQ
state. A complete `200` transitions it to `delivered`; redelivery then skips Tinybird and only resumes
queue acknowledgement. `429`, `500`, and `503` transition it to `retryable` before bounded redelivery.
`400`, `403`, and `404` transition it to `poison_pending`.

The queue is a backpressure boundary, not a substitute for data-quality admission. Authentication,
authorization, strict schema and Event Definition validation, body and item bounds, idempotency, and
per-credential rate limits run before queue publication. Invalid or undeclared input never consumes
queue or Tinybird capacity. Valid accepted rows are buffered without sampling or silent thinning;
protecting Tinybird may increase freshness lag but does not bias the retained event stream.

An aggregate Ingest Admission Gate also runs before any new idempotency claim, outbox write, or queue
publication. It is keyed by `(app_id, environment_id, ingest_stream)`, where `ingest_stream` is the
destination datasource. The gate charges both canonical row count and serialized queue-payload
bytes, so batching cannot bypass it. It composes with per-credential rate limits and rejects the
complete request with `429 RATE_LIMITED` when either budget is unavailable. Exact idempotent retries
that require no new queue publication consume no aggregate capacity. This is an operational fairness
and Tinybird-protection control, not billing, quota, sampling, or a customer-configurable spend guard.
Concurrent attempts that both precede the winning family-scoped claim may conservatively consume
capacity more than once while still producing one logical row; the separate Durable Objects do not
refund or exactly deduplicate admission tokens across that race.

The Event Ingest Worker implements the gate as one SQLite-backed
`IngestAdmissionGateDurableObject` instance per `(app_id, environment_id, ingest_stream)`. Each
instance owns exactly two token buckets, one for rows and one for serialized queue-payload bytes. It
refills and attempts both deductions atomically using its own clock; both deductions succeed or
neither is persisted. This gives the scope one strongly coordinated budget across Cloudflare
locations without routing unrelated Apps, Environments, or streams through a global singleton. The
Admission Gate instances are separate from event-id deduplication and durable outbox shards because
those shards serialize per-event acceptance, while this object serializes aggregate capacity.

The checked-in launch profile uses a 10-second burst window:

| `ingest_stream`   | Row refill | Row capacity | Byte refill                 | Byte capacity             |
| ----------------- | ---------- | ------------ | --------------------------- | ------------------------- |
| `raw_evaluations` | 250 rows/s | 2,500 rows   | 262,144 bytes/s (256 KiB/s) | 2,621,440 bytes (2.5 MiB) |
| `raw_events`      | 300 rows/s | 3,000 rows   | 524,288 bytes/s (512 KiB/s) | 5,242,880 bytes (5 MiB)   |
| `metric_events`   | 100 rows/s | 1,000 rows   | 524,288 bytes/s (512 KiB/s) | 5,242,880 bytes (5 MiB)   |
| `web_events`      | 500 rows/s | 5,000 rows   | 1,048,576 bytes/s (1 MiB/s) | 10,485,760 bytes (10 MiB) |

These platform-owned values are explicit configuration, not customer overrides, runtime
auto-tuning, or hidden defaults. A change requires reviewed load evidence showing stable queue age,
no sustained Tinybird `429` responses, and recovery after a 2x burst. Because the budgets are
independent per `(app_id, environment_id, ingest_stream)`, they provide tenant fairness and spike
isolation but do not impose a global cap on Tinybird traffic. The fixed per-datasource queue
consumer governor remains the hard Tinybird protection boundary.

For claim-backed Metric Events and Web Events, the family-scoped idempotency claim and canonical
delivery payload are sealed atomically in the durable ingest outbox before `202 accepted` is
returned. An Exposure payload is likewise sealed before the Evaluation Worker returns its Variant;
the same transaction includes the scoped Evaluation claim, result fingerprint, and retry-stable
Exposure row. The Assignment Store write begins only after that seal succeeds. The outbox retries
publication to Cloudflare Queue until it succeeds. For other intake, an accepted response requires either an
equivalent durable outbox seal or successful durable queue handoff. Acceptance does not wait for
Tinybird. At-least-once queue and Tinybird retries preserve the stable per-row dedup key and may create
duplicate physical rows; downstream dedup remains authoritative. Metric and Web reads use the
aggregate-state `serve_deduped_metric_events` and `serve_deduped_web_events` sources defined by
ADR-0045. Tinybird does not enforce `dedup_key` uniqueness.

## Considered options

- **Keep direct one-row Tinybird requests:** rejected because request volume scales linearly with
  event volume, wastes Tinybird's NDJSON ingestion path, and cannot operate within datasource
  request-rate limits at product scale.
- **Forward each SDK request directly as one Tinybird batch:** rejected because it preserves browser
  batching but cannot coalesce traffic across clients, runtimes, or internal Evaluation requests.
- **Add a separate ingest service:** rejected because the Event Ingest Worker already owns
  validation, idempotency, queueing, and Tinybird delivery. Cloudflare Queues add the durable
  buffering primitive without creating another service boundary.
- **Use the generic Cloudflare Rate Limiting binding for aggregate admission:** rejected because it
  counts limiter calls rather than weighted rows and bytes, and its counters are local to a
  Cloudflare location rather than one strongly coordinated per-scope budget.
- **Use one global Admission Gate Durable Object:** rejected because unrelated Apps, Environments,
  and streams would share one coordination bottleneck and failure domain.
- **Use queue-backed datasource microbatches in the existing Worker:** accepted because it provides
  durable backpressure, batches across callers, isolates Tinybird latency from intake, and preserves
  the append-only at-least-once model.

## Consequences

The refactor must add four primary Queue producer and consumer bindings, four matching dead-letter
queues, write-ahead delivery-attempt state, bounded retries, queue age/backlog/failure telemetry, and
contract tests proving that multiple rows produce one Tinybird NDJSON request. Existing direct append
helpers and sequential row loops must be deleted, not retained as a fallback transport. The public SDK
never receives Tinybird credentials, and the queues do not change the separate datasource schemas or
event-family contracts.
Capacity controls must favor Tinybird health over automatic backlog catch-up; a growing queue alerts
operators instead of silently increasing Tinybird write concurrency.

Physical retry correctness also requires the ADR-0045 aggregate-state materializations and serving
Pipes. Tinybird delivery succeeds only on a `wait=true` `200` response whose acknowledged row count
matches and whose quarantined row count is zero. `429`, `500`, and `503` retry with the fixed
governor; permanent failures use `poison_pending` then `poison_transferred`; `422` and any unresolved
write-ahead attempt use
durable indeterminate reconciliation and never blind queue retry. A queue consumer is incomplete if
analytics still scans the full physical Metric or Web event log for every request.

The Event Ingest Worker must also add the SQLite Admission Gate Durable Object binding and migration,
stable per-scope object routing, atomic dual-bucket contract tests, cross-caller contention tests,
and fail-closed binding tests. This coordination path is independent of the event-id outbox shards
and must never be collapsed into one global object.

Permanent-failure handling must persist and test both poison states so a failed DLQ copy does not
create an ordinary Tinybird retry loop or premature queue acknowledgement. Privacy deletion jobs and
every reconciliation or manual DLQ replay must also cover pending ingest outboxes, primary queues,
write-ahead delivery attempts, indeterminate records, both poison states, and DLQs.

## Sources

- [Tinybird Events API](https://www.tinybird.co/docs/api-reference/events-api)
- [Tinybird Events API ingestion guidance](https://www.tinybird.co/docs/forward/ingest-data/events-api)
- [Cloudflare Queue batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Queue consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
- [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
