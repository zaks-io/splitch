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

Serving queries: `snapshot UNION ALL fresh_tail_since_last_ingest_watermark`.

The snapshot covers the bulk; the real-time tail covers rows ingested at or after the snapshot
watermark. The inclusive boundary puts the exact watermark instant in both inputs so the final UNION
can re-dedup it instead of risking a missed row. No row is missed or double-counted in the served
result.

## First-touch definition (identical in both layers)

```sql
SELECT
  app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
  MIN(exposure_at) AS first_exposure_ts,
  CASE WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__'
       ELSE MAX(variant) END AS variant
FROM raw_events
WHERE type = 'exposure'
  AND ingest_ts <= {snapshot_watermark_ts}
GROUP BY app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash
```

Both layers use `MIN(exposure_at)` for first-touch and the same conflict-aware aggregate that emits
`__multiple__` when an Entity has more than one Variant in a Run. The snapshot uses the predicate
shown above. The tail applies the same selection with
`ingest_ts >= coalesce(last_snapshot_watermark_ts, epoch)`. These ranges deliberately overlap at the
exact watermark instant so a concurrent insertion cannot fall between the layers, and the final
UNION re-dedups that boundary overlap. The final UNION also re-dedups later physical rows for an
Entity already in the snapshot. The tail boundary uses `ingest_ts`, not `server_received_at`, because
late-arriving rows can have an event timestamp older than the snapshot. Both are generated from the
canonical definition in
[pipeline/dedup-query-contract.md](../pipeline/dedup-query-contract.md), never hand-copied
(ADR-0005 "one dedup, centralized" at the physical layer).
When the latest snapshot contains no rows, its row-carried watermark is null. The tail uses the Unix
epoch fallback and scans all retained raw rows until the first nonempty snapshot, preserving
correctness.

## Snapshot datasource shape

```
ExposureSnapshot {
  app_id:           string    // required — SORTING_KEY position 1 (isolation + cardinality)
  environment_id:   string    // required — SORTING_KEY position 2; co-scoped, per-Environment (ADR-0027)
  experiment_id:    string    // required — SORTING_KEY position 3
  run_id:           string    // required
  targeting_key_hash:    string    // required, HMAC-derived Entity identity
  id_type:          string    // required
  variant:          string    // required — '__multiple__' if conflict
  first_exposure_ts: datetime  // required — MIN(exposure_at) from raw log
  watermark_ts:     datetime  // required — inclusive ingest boundary captured at snapshot start
}
```

The inclusive boundary puts rows at `watermark_ts` in both layers so final UNION dedup can collapse
the overlap instead of risking a missed boundary row.

`ENGINE_SORTING_KEY`:
`(app_id, environment_id, experiment_id, run_id, variant, targeting_key_hash)`. `app_id` is first for
tenant isolation; `environment_id` is co-scoped; low-cardinality `variant` precedes the
high-cardinality Entity hash for per-arm Run reads (ADR-0027).

## Rollups rebuild after the snapshot

Replace-mode rollup Copy Pipes rebuild from the completed deduped snapshot, never the raw log.
Tinybird materialized views are not used here: they fire per inserted block and do not retract prior
target state when the source snapshot is replaced, so repeated snapshots would inflate counts. The
ordered replace copies preserve both dedup correctness and repeatability (ADR-0017, ADR-0024).

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
SELECT ... FROM raw_events
WHERE type = 'exposure'
  AND app_id = {{String(app_id)}}
  AND environment_id = {{String(environment_id)}}
GROUP BY app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash
-- MIN(exposure_at), __multiple__ quarantine, etc.

-- production query (tenant-scoped snapshot + derived watermark + tail + final dedup):
WITH
snapshot AS (
  SELECT
    app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
    variant, first_exposure_ts
  FROM deduped_exposures
  WHERE app_id = {{String(app_id)}}
    AND environment_id = {{String(environment_id)}}
),
watermark AS (
  SELECT coalesce(
    MAX(watermark_ts),
    toDateTime64('1970-01-01 00:00:00', 3, 'UTC')
  ) AS watermark_ts
  FROM deduped_exposures
  WHERE app_id = {{String(app_id)}}
    AND environment_id = {{String(environment_id)}}
),
tail AS (
  SELECT
    app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
    CASE WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__'
         ELSE MAX(variant) END AS variant,
    MIN(exposure_at) AS first_exposure_ts
  FROM raw_events
  CROSS JOIN watermark
  WHERE type = 'exposure'
    AND app_id = {{String(app_id)}}
    AND environment_id = {{String(environment_id)}}
    AND ingest_ts >= watermark.watermark_ts
  GROUP BY app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash
)
SELECT
  app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
  MIN(first_exposure_ts) AS first_exposure_ts,
  CASE WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__'
       ELSE MAX(variant) END AS variant
FROM (
  SELECT * FROM snapshot
  UNION ALL
  SELECT * FROM tail
)
GROUP BY app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash
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
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
