# Metric and Web retry dedup uses aggregate-state materialization

**Status:** accepted

Metric Events and Web Events are append-only Tinybird logs delivered at least once. Tinybird does
not enforce uniqueness for a `dedup_key`, and full-log query-time deduplication is not the steady
state for enterprise volume. Physical retries must not inflate Experiment statistics or Web
Analytics.

## Decision

Each event family has three physical and logical layers:

1. `metric_events` or `web_events` remains the append-only system of record.
2. A continuous materialized Pipe emits one
   `argMinState(tuple(<canonical row>), ingest_ts)` state per retry key and inserted block into
   `deduped_metric_events_state` or `deduped_web_events_state`. Both targets use
   `AggregatingMergeTree`, tenant-first sorting keys, event-date partitions, and exact
   `server_received_at` dimensions for raw/state TTL parity.
3. `serve_deduped_metric_events` or `serve_deduped_web_events` filters the state datasource by
   injected App, Environment, event-date, and precise requested-time bounds, groups by the complete
   family retry key, applies `argMinMerge`, and then flattens the canonical tuple.

Background `AggregatingMergeTree` merges reduce stored states but are not the correctness boundary.
The serving Pipe always groups and merges aggregate states, including states still held in separate
parts. Idempotency claims guarantee that physical rows sharing one `dedup_key` have the same
canonical payload, so choosing the earliest physical `ingest_ts` remains deterministic.

This is not the forbidden raw-log rollup from ADR-0017 and ADR-0024. The materialization stores a
mergeable canonical-row state, and the serving Pipe completes `argMinMerge` across every matching
state before any count, sum, percentile, session association, or statistical aggregate sees the
row. No downstream rollup consumes per-block retry counts.

Every Metric query reads `serve_deduped_metric_events` before field extraction or statistical
aggregation. Every Web Analytics query reads `serve_deduped_web_events` before session association,
journey ordering, counts, or percentiles. Neither query surface reads the full physical log and
deduplicates it for every request.

## Considered options

- **Declare `dedup_key` as a Tinybird uniqueness setting:** rejected because Tinybird datasource
  files expose no such instruction and Tinybird does not enforce primary-key uniqueness.
- **Deduplicate the full raw log at query time:** rejected as a serving path. Scoped raw scans remain
  available only for reconciliation and rebuild verification; their cost grows with retained physical
  rows.
- **Use `ReplacingMergeTree` as the raw system of record:** rejected because background merge timing
  is not a correctness boundary and replacing rows weakens replayable raw truth.
- **Use full-replace Copy Pipe snapshots:** rejected for these high-volume facts because the default
  Copy mode is append, replace jobs are capped at 100 million output rows, and a delayed queue or DLQ
  delivery complicates snapshot watermarks. Copy Pipe snapshots remain appropriate for the
  separately defined Exposure first-touch reducer in ADR-0024.
- **Materialize mergeable aggregate states continuously:** accepted because it moves retry collapse
  off raw request-time scans, has no periodic full-history copy, remains correct before background
  parts merge, and can rebuild from retained raw truth.

## Consequences

Implementation must add two aggregate-state datasources, two materialized Pipes, and two serving
Pipes. State TTL uses the full `server_received_at` timestamp and must exactly match the corresponding
raw family retention. Entity and App deletion covers both state datasources, and each state datasource
can be rebuilt from the retained raw log.

Both destination `.datasource` files declare `BACKFILL skip`; `tb deploy --check` must prove Forward
will not run its default all-history materialized-view population. With reads and intake still blocked,
initial population then runs one App, Environment, and half-open source timestamp month at a time. A
repair blocks the same scope, drains in-flight delivery and write-ahead attempts, deletes only that
target slice, appends one bounded populate from raw truth, and reconciles distinct retry-key counts
plus zero canonical-row mismatches before resuming. Sampled rows are retained as audit evidence.
Tinybird populate is append by default, so no repair treats it as replacement or races it against live
writes. Failure keeps the scope blocked.

Contract tests insert duplicate physical rows in separate ingest blocks, query before and after
background part merges, and prove one logical event is returned. Reconciliation tests prove a
write-ahead attempt prevents any request before durable recovery state exists; Tinybird `422` and an
unresolved attempt exercise raw-plus-state, raw-only, absent, and unresolved outcomes without blind
retry. Raw-only repair populates state without replaying raw ingestion. Rebuild tests prove
`BACKFILL skip`, the scope block, drain, delete, bounded append populate, exact reconciliation, and
raw/state expiry parity. Tests also fail any Metric or Web Analytics Pipe that reads a physical event
log directly.

## Sources

- [Tinybird datasource file instructions](https://www.tinybird.co/docs/forward/dev-reference/datafiles/datasource-files)
- [Tinybird deduplication strategies](https://www.tinybird.co/docs/forward/guides/deduplication-strategies)
- [Tinybird materialized views](https://www.tinybird.co/docs/forward/core-concepts/materialized-views)
- [Tinybird datasource evolution and `BACKFILL skip`](https://www.tinybird.co/docs/forward/guides/evolve-data-source)
- [Tinybird materialized-view populate API](https://www.tinybird.co/docs/api-reference/pipe-api/materialized-views)
- [Tinybird AggregatingMergeTree](https://www.tinybird.co/docs/sql-reference/engines/aggregatingmergetree)
- [Tinybird Copy Pipe limits](https://www.tinybird.co/docs/api-reference/pipe-api/copy-pipes-api)
- [ADR-0024](./0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md)
- [Physical dedup pipes](../spec/pipeline/physical-dedup-pipes.md)
