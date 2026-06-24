# Physical dedup engine — Copy Pipe, serving UNION, materialized views

Pins the Tinybird pipes and materialized views that derive the deduped serving layer from the raw log: the batch Copy Pipe, the snapshot+tail serving UNION, and rollup MVs. Datasource shapes are in [physical-datasources.md](./physical-datasources.md). ADR-0024 lambda architecture.

## Copy Pipe (batch layer)

```
pipe: cp_deduped_exposures
COPY_MODE: replace                  -- full rebuild each run; incremental if volume demands it
COPY_SCHEDULE: @hourly              -- freshness/cost dial; not a correctness dial (tail covers the gap)

SOURCE QUERY (the canonical dedup definition):
  SELECT
    app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
    MIN(server_ts)                                        AS first_exposure_ts,
    CASE WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__'
         ELSE MAX(variant) END                           AS variant,
    now64(3)                                              AS snapshot_ts,
    {copy_watermark_ts: DateTime64(3)}                    AS watermark_ts
  FROM raw_events
  WHERE type = 'exposure'
    AND ingest_ts <= {copy_watermark_ts: DateTime64(3)}
  GROUP BY app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash

TARGET: deduped_exposures
```

The schedule is hourly by default. The real-time tail covers the window since the last snapshot, so a slower schedule never produces incorrect results, only a larger tail at query time.

`copy_watermark_ts` is captured at the start of the Copy Pipe run. It is an ingest-time watermark,
not an event-time watermark. `server_ts` remains the analysis clock; `ingest_ts` only answers
"was this raw row already included in the snapshot?" This prevents a late-arriving row with an
old `server_ts` from falling between the snapshot and the tail.

**COPY_MODE `replace` vs incremental:** start with `replace` (simpler, always correct). Switch to incremental (append only rows since `MAX(snapshot_ts)`) when full-rebuild scan time grows measurable. The `snapshot_ts` column enables this transition.

## Serving pipe (snapshot + tail UNION)

```
pipe: serve_deduped_exposures

NODE snapshot_layer:
  SELECT app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash, variant, first_exposure_ts
  FROM deduped_exposures

NODE tail_layer:
  -- dedup query applied only to raw rows since the last snapshot
  SELECT
    app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
    MIN(server_ts)                                        AS first_exposure_ts,
    CASE WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__'
         ELSE MAX(variant) END                           AS variant
  FROM raw_events
  WHERE type = 'exposure'
    AND ingest_ts > (SELECT MAX(watermark_ts) FROM deduped_exposures)
  GROUP BY app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash

NODE union_and_final_dedup:
  -- UNION ALL, then re-dedup to handle rows straddling the snapshot boundary
  SELECT
    app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
    MIN(first_exposure_ts)                                AS first_exposure_ts,
    CASE WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__'
         ELSE MAX(variant) END                           AS variant
  FROM (
    SELECT * FROM snapshot_layer
    UNION ALL
    SELECT * FROM tail_layer
  )
  GROUP BY app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash
```

The tail uses `ingest_ts`, not `server_ts`, so events that arrive after the snapshot ran but
carry an earlier `server_ts` still appear in the tail. The final union re-dedup then lets
`MIN(server_ts)` choose the first-touch row. This is the correct behavior per ADR-0010.

**Shared definition rule (ADR-0024, seam finding):** The dedup logic in the Copy Pipe and the tail node is identical. Both are generated from one shared Jinja template at build time — never hand-copied. Drift between the two is a correctness failure.

## Materialized Views (rollups off snapshot, never raw log)

All MVs attach to `deduped_exposures`, never to `raw_events`. Attaching to `raw_events` would leak redundant edge events into rollup counts (double-counting), invalidating SRM and all metrics (ADR-0024, ADR-0017).

### MV 1: SRM numerators (`mv_srm_counts`)

```
materialized_view: mv_srm_counts
SOURCE: deduped_exposures           -- AggregatingMergeTree off snapshot

SCHEMA:
  app_id          String
  environment_id  String            -- run-implied; carried for per-Environment dashboard filtering
  experiment_id   String
  run_id          String
  variant         String            -- may be '__multiple__'
  entity_count    AggregateFunction(count, UInt64)

-- Selection: rows where variant != '__multiple__' for SRM; '__multiple__' rows feed conflict_rate
```

Enables fast SRM chi-square computation: fetch `entity_count` per arm per run, compare against `declared_allocation`.

### MV 2: Activation rate (`mv_activation_rate`)

```
materialized_view: mv_activation_rate
SOURCE: deduped_exposures           -- joined with raw_events activations at MV build time

SCHEMA:
  app_id          String
  environment_id  String            -- run-implied; carried for per-Environment dashboard filtering
  experiment_id   String
  run_id          String
  variant         String
  exposed_count   AggregateFunction(count, UInt64)
  activated_count AggregateFunction(countIf, UInt64)   -- activation_ts > first_exposure_ts
```

Enables fast per-arm activation rate reads for the bias guardrail dashboard.

## Freshness SLA

| Layer                                 | Latency                                                                | Correctness                         |
| ------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| Raw ingest (`raw_events`)             | Near-real-time (Workers → Tinybird Events API)                         | Always correct (raw is truth)       |
| Snapshot (`deduped_exposures`)        | Up to 1 hour stale                                                     | Correct — tail covers the gap       |
| Serving queries                       | Tail covers since last snapshot; ~1h lag for bulk + real-time for tail | Always correct                      |
| `mv_srm_counts`, `mv_activation_rate` | Snapshot cadence (~1h)                                                 | Guardrail dashboards refresh hourly |

## Sources

- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — raw log, system of record, replayability
- [ADR-0017](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md) — Tinybird as analytics system; MVs off snapshot
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — lambda architecture; shared dedup definition; rollups off snapshot
- [Snowplow deduplication](https://docs.snowplow.io/docs/modeling-your-data/modeling-your-data-with-dbt/package-mechanics/deduplication/) — at-least-once delivery and downstream earliest-timestamp dedup
- [BigQuery streaming inserts](https://docs.cloud.google.com/bigquery/docs/streaming-data-into-bigquery) — best-effort ingest dedup is not the analysis authority
- [Snowflake QUALIFY](https://docs.snowflake.com/en/sql-reference/constructs/qualify) — first-row window filtering pattern
