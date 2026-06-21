# Physical Exposure dedup engine: lambda architecture (Copy Pipe snapshot + real-time UNION)

**Status:** accepted

ADR-0010 decided the Exposure pipeline *logically* — ELT, raw append-only log as the system of
record, first-touch dedup as a re-runnable windowed query at analysis time. It deliberately left the
*physical* engine open. This ADR pins it: on Tinybird (ADR-0017), first-touch is served by a **lambda
architecture** — a scheduled **Copy Pipe** snapshots the deduped first-touch table, and serving
queries **`UNION ALL` the snapshot with raw rows ingested after the snapshot watermark**, deduping
only that small tail at query time. The raw log stays the source of truth and the snapshot is always
rebuildable from it, so ADR-0010's replayability is preserved; what changes is that the expensive
windowed dedup runs on a schedule over the bulk, not on every analysis query over the full history.

The first-touch definition is unchanged from ADR-0010 — `MIN(ts)` per `(entity, run)`, equivalently
`QUALIFY ROW_NUMBER() OVER (PARTITION BY entity, run ORDER BY ts) = 1`. It now lives in two places that
must stay identical: the Copy Pipe that builds the snapshot, and the real-time tail query. Both are
generated from one shared definition, never hand-copied (this is ADR-0005's "one dedup, centralized"
at the physical layer).

The physical boundary is deliberately **not** `server_ts > last_snapshot_ts`. `server_ts` is the
analysis clock used for first-touch and Conversion Window anchoring; late-arriving rows can have an
older `server_ts` than the snapshot. The Copy Pipe records an ingest-time `watermark_ts`, and the
tail reads `raw_events.ingest_ts > watermark_ts`. The final UNION re-dedups by `MIN(server_ts)`, so
late arrivals still become first-touch when their event time is earliest.

## Considered options

- **Pure query-time dedup over the full raw log** (`argMax`/`QUALIFY` on every analysis query) —
  rejected as the steady state. The skill's own guidance scopes this to "prototyping or small
  datasets"; the Exposure log is unbounded and high-volume by ADR-0010's construction, and the
  redundant-by-design edge stream (ADR-0004) inflates it further. Re-scanning all of history per
  query is the thing lambda exists to avoid. It remains the correct **v0** while volume is tiny — the
  snapshot layer is a strict refinement we add when scans get slow, not a different design.
- **ReplacingMergeTree + `FINAL`** — rejected. RMT collapses the raw log to "latest row per key,"
  which is the wrong reducer (we want *earliest* `ts`, first-touch) and, decisively, it would
  destroy raw-as-truth: ADR-0010 requires the complete redundant log to stay intact so the transform
  can be re-run when a rule changes. `FINAL` is also a per-query merge cost the skill flags for
  removal under load. RMT answers "current state per key"; Exposure analysis is "first event per key
  over an immutable log" — a different question.
- **AggregatingMergeTree materialized view straight off the raw log** — rejected, and called out as a
  correctness trap, not just a performance one. A materialized view fires per inserted block and
  never sees merged or cross-block state, so it cannot dedup the redundant edge events ADR-0004
  guarantees — duplicates leak into the rollup and silently inflate the SRM denominator and every
  metric count. Rollup MVs therefore feed the **deduped snapshot**, never the raw log (see ADR-0017,
  amended).

## Consequences

- **Two physical layers for one logical log.** The raw `.datasource` (append-only, the system of
  record) plus a snapshot `.datasource` (Copy Pipe target, `COPY_MODE replace` or incremental per
  volume). Serving pipes read snapshot ∪ tail. More moving parts than a single query, accepted as the
  cost of bounded query latency over unbounded data.
- **Snapshot cadence is a freshness/cost dial, not a correctness one.** The real-time tail always
  covers rows after the snapshot ingest watermark, so a slower schedule never makes results wrong,
  only the batch layer staler — and the tail absorbs late-arriving earlier-`server_ts` events on the
  next read, exactly as ADR-0010 requires.
- **Rollups hang off the snapshot.** Any AggregatingMergeTree rollup MV builds on the deduped
  snapshot datasource, never the raw log — this is the single rule that keeps redundant edge events
  from double-counting. Recorded here and cross-referenced from ADR-0017.
- **Raw log gets a TTL once the snapshot is authoritative.** The raw datasource can carry a retention
  TTL sized to "longer than any rule-change replay window we promise," because the snapshot, not the
  raw tail, serves normal analysis. (Detail for the datasource build, not re-litigable here.)
- **Deferred, not pre-built.** v0 ships pure query-time dedup (ADR-0010 as written); this lambda
  structure is introduced when raw-log scan cost shows up in `pipe_stats_rt`. The design is recorded
  now so the v0 query is written as a drop-in tail of the eventual UNION, not a throwaway.

## Sources

- Snowplow deduplication: at-least-once delivery and downstream earliest-timestamp dedup:
  https://docs.snowplow.io/docs/modeling-your-data/modeling-your-data-with-dbt/package-mechanics/deduplication/
- BigQuery streaming inserts: best-effort insert dedup should not be relied on as the analysis
  dedup authority:
  https://docs.cloud.google.com/bigquery/docs/streaming-data-into-bigquery
- Snowflake QUALIFY: canonical `ROW_NUMBER() ... QUALIFY = 1` first-touch shape:
  https://docs.snowflake.com/en/sql-reference/constructs/qualify
