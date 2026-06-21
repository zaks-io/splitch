# Physical dedup engine: lambda architecture (Copy Pipe snapshot + real-time tail)

ADR-0010 decided the Exposure pipeline logically (ELT, raw log, query-time dedup). This file pins
the physical engine in Tinybird: a lambda architecture that avoids re-scanning full history on every
analysis query.

## Architecture

```
raw Exposure log (.datasource, append-only)
        |
        |──── Copy Pipe (scheduled) ────► first-touch snapshot (.datasource, COPY_MODE)
        |
        |──── real-time tail query ──────► rows since last snapshot
                                                    |
                                              UNION ALL
                                                    |
                                          ► deduped first-touch rows (served to analysis)
```

Serving queries: `snapshot UNION ALL fresh_tail_since_last_snapshot`.

The snapshot covers the bulk; the real-time tail covers the gap since the last snapshot. No row is
missed; no row is double-counted (the snapshot already deduplicated its window, the tail is deduped
inline).

## First-touch definition (identical in both layers)

```sql
-- snapshot (Copy Pipe):
QUALIFY ROW_NUMBER() OVER (PARTITION BY targeting_key, experiment_id, run_id ORDER BY server_ts) = 1

-- real-time tail (inline dedup on fresh rows):
WHERE server_ts > {last_snapshot_ts}
QUALIFY ROW_NUMBER() OVER (PARTITION BY targeting_key, experiment_id, run_id ORDER BY server_ts) = 1
```

Both use `ROW_NUMBER()` equivalent to `MIN(server_ts)`. Both are generated from one shared
definition, never hand-copied (ADR-0005 "one dedup, centralized" at the physical layer).

## Snapshot datasource shape

```
ExposureSnapshot {
  app_id:           string    // required — SORTING_KEY position 1 (isolation + cardinality)
  experiment_id:    string    // required — SORTING_KEY position 2
  run_id:           string    // required
  targeting_key:    string    // required
  id_type:          string    // required
  variant:          string    // required — '__multiple__' if conflict
  first_exposure_ts: datetime  // required — MIN(server_ts) from raw log
  event_type:       string    // 'exposure' | 'activation'
}
```

`ENGINE_SORTING_KEY`: `(app_id, experiment_id, run_id, targeting_key)` — `app_id` first for
tenant isolation and low-cardinality range efficiency.

## Rollup materialized views must build off the snapshot

AggregatingMergeTree MVs build on the deduped snapshot, never the raw log. A MV fires per
inserted block and never sees merged or cross-block state, so raw-log edge duplicates (ADR-0004)
leak into rollups and silently inflate SRM denominators and metric counts. The snapshot is the
correct and only correct MV source (ADR-0017, ADR-0024).

## Snapshot cadence

The snapshot cadence is a freshness/cost dial, not a correctness one. A slower schedule means a
staler batch layer and a larger real-time tail to dedup inline — never wrong results. Recommended
default: hourly for moderate volume, more frequent under high load.

## v0 vs production path

v0 ships pure query-time dedup (ADR-0010 as written, no snapshot layer). The v0 query is structured
as a drop-in tail of the eventual UNION so the snapshot can be added without rewriting analysis
queries:

```sql
-- v0 query (full history, no snapshot):
SELECT ... FROM raw_exposures
WHERE app_id = {{String(app_id)}}
GROUP BY targeting_key, experiment_id, run_id
-- MIN(server_ts), __multiple__ quarantine, etc.

-- production query (snapshot + tail):
SELECT * FROM first_touch_snapshot WHERE app_id = {{String(app_id)}}
UNION ALL
SELECT ... FROM raw_exposures
WHERE app_id = {{String(app_id)}} AND server_ts > {{DateTime(last_snapshot_ts)}}
GROUP BY ...
```

Introducing the lambda layer is a performance optimization, not a correctness change. Trigger: when
`pipe_stats_rt` shows scan cost growing with raw log volume.

## Raw log TTL

Once the snapshot is authoritative, the raw log can carry a retention TTL sized to "longer than any
rule-change replay window promised." The snapshot is always rebuildable from the raw log within its
TTL window.

## Sources

- [../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
