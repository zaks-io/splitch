# Physical dedup engine: Exposure Copy Pipe and event retry states

Pins the Tinybird Pipes and materialized views that derive deduped serving layers from raw logs:
Exposure snapshot plus tail, Activation/Metric/Web aggregate states, and replace-mode Exposure
rollups.
Datasource shapes are in [physical-datasources.md](./physical-datasources.md). ADR-0024 defines the
Exposure lambda architecture and Activation state; ADR-0045 defines Metric/Web retry states.

## Copy Pipe (batch layer)

```
pipe: cp_deduped_exposures
COPY_MODE: replace                  -- mandatory full rebuild; incremental append is forbidden
COPY_SCHEDULE: @hourly              -- freshness/cost dial; not a correctness dial (tail covers the gap)

SOURCE QUERY (the canonical dedup definition):
  SELECT
    app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
    MIN(exposure_at)                                               AS first_exposure_ts,
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
not an event-time watermark. `exposure_at` remains the analysis clock; `ingest_ts` only answers
"did this raw row fall at or before the snapshot's inclusive insertion boundary?" Equality also stays
in the tail, deliberately overlapping the boundary so final UNION dedup prevents a concurrent
insertion at the exact watermark from being missed. This prevents a late-arriving row with an old
`exposure_at` from falling between the snapshot and the tail.

`COPY_MODE replace` is mandatory. Incremental append since `MAX(snapshot_ts)` is not equivalent to the
ingest watermark, can retain duplicate snapshot keys, and is forbidden. If full rebuild cost exceeds
the operating budget, the replacement design must be re-specified and proven before implementation;
the consumer cannot switch modes as a tuning change.

## Serving pipe (snapshot + tail UNION)

```
pipe: serve_deduped_exposures

NODE snapshot_layer:
  SELECT app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash, variant, first_exposure_ts
  FROM deduped_exposures
  WHERE app_id = {app_id: String}
    AND environment_id = {environment_id: String}

NODE tail_layer:
  -- dedup query applied only to raw rows since the last snapshot
  SELECT
    app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
    CASE WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__'
         ELSE MAX(variant) END                           AS variant,
    MIN(exposure_at)                                               AS first_exposure_ts
  FROM raw_events
  WHERE type = 'exposure'
    AND app_id = {app_id: String}
    AND environment_id = {environment_id: String}
    AND ingest_ts >= (
      SELECT coalesce(
        MAX(watermark_ts),
        toDateTime64('1970-01-01 00:00:00', 3, 'UTC')
      )
      FROM deduped_exposures
      WHERE app_id = {app_id: String}
        AND environment_id = {environment_id: String}
    )
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

The snapshot uses `ingest_ts <= watermark`; the tail uses `ingest_ts >= watermark`. These ranges
deliberately overlap at the exact watermark instant so a concurrent insertion cannot fall between the
snapshot and tail, and the final union re-dedups that boundary overlap. The final union also re-dedups
because a later physical retry or Exposure for an Entity already in the snapshot belongs to the tail.
The boundary uses `ingest_ts`, not `exposure_at`, so events that arrive after the snapshot ran
but carry an earlier `exposure_at` still appear in the tail. `MIN(exposure_at)` then
chooses the first-touch row. This is the correct behavior per ADR-0010.
`raw_events` partitions by receipt month and keeps an App/Environment sorting prefix. The
`ingest_ts` predicate is still the correctness boundary for late Queue delivery and replay; the
consumer-cutover performance gate must prove this deployed layout remains within its scan budget.
An empty snapshot has no row-carried watermark, so the tail explicitly falls back to the Unix epoch
and scans all retained raw rows. This preserves correctness until the first nonempty snapshot; it
cannot turn a null aggregate into an empty result.

**Shared definition rule (ADR-0024, seam finding):** The dedup logic in the Copy Pipe and the tail node is identical. Both are generated from one shared Jinja template at build time — never hand-copied. Drift between the two is a correctness failure.

## Activation and event aggregate states

Activation, Metric, and Web reads use continuous aggregate-state materialization without periodic
full-history Copy jobs. Activation state preserves retry-deduplicated candidate timestamps so analysis
can select the earliest valid post-Exposure Activation; Metric and Web states preserve the
earliest-ingested canonical row per retry key.

| Family       | Raw log         | State datasource              | Materialized Pipe                | Serving Pipe                  |
| ------------ | --------------- | ----------------------------- | -------------------------------- | ----------------------------- |
| Activation   | `raw_events`    | `deduped_activations_state`   | `mv_deduped_activations_state`   | `serve_deduped_activations`   |
| Metric Event | `metric_events` | `deduped_metric_events_state` | `mv_deduped_metric_events_state` | `serve_deduped_metric_events` |
| Web Event    | `web_events`    | `deduped_web_events_state`    | `mv_deduped_web_events_state`    | `serve_deduped_web_events`    |

The Activation materialized Pipe writes this state:

```sql
SELECT
  app_id,
  environment_id,
  experiment_id,
  run_id,
  toDate(assumeNotNull(activation_ts)) AS event_date,
  id_type,
  targeting_key_hash,
  counterfactual,
  assumeNotNull(activation_ts) AS activation_ts,
  minState(assumeNotNull(activation_ts)) AS activation_state
FROM raw_events
WHERE type = 'activation' AND activation_ts IS NOT NULL
GROUP BY
  app_id,
  environment_id,
  experiment_id,
  run_id,
  event_date,
  id_type,
  targeting_key_hash,
  counterfactual,
  activation_ts
```

Event Ingest rejects an Activation without `activation_ts` before it reaches `raw_events`. The
materialized Pipe repeats the non-null filter at the physical boundary and uses `assumeNotNull` only
after that filter so the target state type is exactly `DateTime64(3)`.

`serve_deduped_activations` injects App, Environment, exact Run, and half-open event-date and
`activation_ts` bounds before merge. It applies `counterfactual = 0` before merge unless the explicit
analysis parameter includes counterfactual rows, then groups by
`(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash, counterfactual,
activation_ts)` and applies `minMerge(activation_state)`. It returns one candidate per distinct
timestamp and counterfactual kind. The consuming Exposure join rejects candidates at or before
`first_exposure_ts` before selecting `MIN(activation_ts)`. Late physical insertion does not change the
activation-time partition, and duplicate states in separate parts cannot inflate the output.

The Metric materialized Pipe writes this state:

```sql
SELECT
  app_id,
  environment_id,
  toDate(server_received_at) AS event_date,
  id_type,
  event_definition_id,
  server_received_at,
  targeting_key_hash,
  dedup_key,
  argMinState(
    tuple(
      event_id,
      event_definition_version_id,
      event_name,
      fields,
      dimensions,
      server_received_at,
      ingest_ts
    ),
    ingest_ts
  ) AS canonical_state
FROM metric_events
GROUP BY
  app_id,
  environment_id,
  event_date,
  id_type,
  event_definition_id,
  server_received_at,
  targeting_key_hash,
  dedup_key
```

The Web materialized Pipe normalizes nullable Entity identity into non-null sorting dimensions and
writes this state:

```sql
SELECT
  app_id,
  environment_id,
  toDate(server_received_at) AS event_date,
  toUInt8(id_type IS NOT NULL) AS has_entity,
  capture_source,
  ifNull(id_type, '') AS id_type_scope,
  event_definition_id,
  server_received_at,
  session_id_hash,
  ifNull(targeting_key_hash, '') AS targeting_key_hash_scope,
  dedup_key,
  argMinState(
    tuple(
      event_id,
      event_definition_version_id,
      event_name,
      sdk_version,
      trace_id,
      span_id,
      fields,
      dimensions,
      server_received_at,
      ingest_ts
    ),
    ingest_ts
  ) AS canonical_state
FROM web_events
GROUP BY
  app_id,
  environment_id,
  event_date,
  has_entity,
  capture_source,
  id_type_scope,
  event_definition_id,
  server_received_at,
  session_id_hash,
  targeting_key_hash_scope,
  dedup_key
```

The targets use `AggregatingMergeTree` and monthly `event_date` partitions. Metric/Web sorting keys
start with mandatory `app_id`, `environment_id`, and `event_date`, then proceed from lower- to
higher-cardinality family dimensions. Activation starts with mandatory `app_id`, `environment_id`,
exact-query `run_id`, and `event_date`. The materialized query selects explicit columns and performs no
JSON extraction, join, sort, or downstream aggregation.

The durable ingest claim guarantees that rows sharing one `dedup_key` have identical canonical
content. A payload mismatch for the same event ID fails before append. Tinybird assigns physical
insertion timestamp `ingest_ts` because producers omit it from NDJSON: `raw_events` uses
`DateTime64(3) DEFAULT now64(3)`, while `metric_events` and `web_events` use
`DateTime64(6) DEFAULT now64(6)`. Queue delay and manual DLQ replay therefore cannot preserve a stale
pre-publication watermark.

Each Metric/Web serving Pipe:

1. filters the state datasource by injected `app_id`, injected `environment_id`, and inclusive
   event-date partitions covering the requested interval, then by inclusive
   `server_received_at >= from` and exclusive `server_received_at < to`;
2. groups by the complete family sorting key and applies `argMinMerge(canonical_state)`;
3. flattens only endpoint-required tuple fields; and
4. performs JSON extraction or downstream aggregation only after the retry-key merge.

Background part merges are a storage and read-amplification optimization only. Explicit `GROUP BY`
plus `minMerge`/`argMinMerge` returns one row when duplicate states still live in separate parts or
ingest blocks. No serving query uses `FINAL`.

Activation gating and activation-rate rollups consume only `serve_deduped_activations`. Metric field
extraction, Conversion Window filtering, and statistical aggregation consume only
`serve_deduped_metric_events`. Web session association, journeys, counts, and percentiles consume only
`serve_deduped_web_events`. Full physical-log query-time dedup is a repair/reconciliation path, not
the target architecture or an enterprise serving path.

The Metric/Web tuple type, materialized grouping dimensions, target sorting key, and serving grouping
dimensions are generated from one definition per family (ADR-0045). Activation materialized
dimensions, state type, sorting key, and serving identity are generated from one Activation
definition. Contract tests fail if any type, column, or ordering drifts.

All three aggregate-state destination `.datasource` files declare `BACKFILL skip`. Before promotion,
`tb deploy --check` must prove Forward will skip its default all-history materialized-view backfill.
The first deployment keeps Activation/Metric/Web intake and reads blocked, deploys the linked
materialized Pipes, then populates one App, Environment, and source month per job. Metric/Web
`populate_condition` clauses use:

```sql
app_id = {app_id}
AND environment_id = {environment_id}
AND server_received_at >= {month_start}
AND server_received_at < {next_month_start}
```

Activation population additionally requires `type = 'activation'` and uses half-open
`activation_ts` month bounds.

Tinybird populate appends to the target by default, so initial population never treats it as
replacement or runs it over an already authoritative slice. Intake and reads open only after every
required scope completes the same exact reconciliation used by repair. `BACKFILL skip` applies on
first datasource creation; later schema/engine evolution requires an explicit reviewed Forward
strategy and a clean `tb deploy --check`.

A repair rebuild uses this replacement-safe cutover for exactly one App, Environment, and month:

1. block analytics reads and new event intake for the scope;
2. drain accepted scoped outboxes and queue deliveries, isolate scoped DLQ, write-ahead-attempt, and
   indeterminate records, and prove no scoped write remains in flight;
3. keep the materialized Pipe linked, then wait for the exact target-slice delete to complete;
4. populate only the exact raw slice with the App/Environment/half-open
   `server_received_at` condition above, append semantics, and no global truncate;
5. require successful populate-job status; Metric/Web require equal distinct retry-key counts and
   zero canonical-row mismatches, while Activation requires equal distinct
   Entity/Run/counterfactual/timestamp candidate counts and zero candidate timestamp mismatches;
   retain sampled rows as audit evidence; and
6. resume reads and intake only after reconciliation succeeds.

Any delete, populate, or reconciliation failure keeps the scope blocked for operator repair. This
prevents live writes from racing between delete and append population. Deleting or truncating raw data
never counts as deleting the materialized target; privacy and retention jobs operate on both layers
explicitly.

### Tinybird performance verification

Before enabling a serving Pipe in an Environment:

- `tb build` must validate each datasource, materialized Pipe, serving Pipe, and duplicate fixture;
- `?explain=true` must show App, Environment, and `event_date` partition filters before
  `minMerge`/`argMinMerge`, with no physical raw-log read;
- `serve_deduped_exposures?explain=true` must show App/Environment primary-key pruning plus
  `ingest_ts` partition/range pruning on the raw tail before first-touch aggregation;
- `tinybird.pipe_stats_rt` must track p50/p95 latency, `read_bytes`, rows read, rows returned, and
  errors for all three state serving Pipes;
- `tinybird.datasources_ops_log` must alert on materialization or populate errors; and
- the Event Ingest consumer must alert on Events API quarantine, unresolved write-ahead/`422`
  reconciliation backlog, `429`, `500`, or `503` responses, and retry/DLQ growth.

Sorting-key or skipping-index changes require measured `EXPLAIN` and runtime evidence. A
rows-read-to-rows-returned ratio above 100x or p95 above 3 seconds triggers a layout review; it does
not permit bypassing tenant scope, the state merge, or raw/state reconciliation.

## Replace-mode Exposure rollup Copy Pipes

Exposure rollups are ordered Copy Pipes, not materialized views. Tinybird materialized views fire on
inserted blocks and do not retract a target when their source is replaced or deleted. Attaching one to
hourly replace-mode `deduped_exposures` would append the same logical population again on every
snapshot and inflate counts.

After `cp_deduped_exposures` completes successfully, one coordinator runs the two rollup copies below
against that completed snapshot. Both use `COPY_MODE replace`; neither runs if the snapshot fails.
Queries and targets use explicit columns and mandatory App/Environment dimensions. A rollup target is
never incrementally appended from snapshot replacement.

### Copy 1: SRM numerators (`cp_srm_counts`)

```
pipe: cp_srm_counts
COPY_MODE: replace
SOURCE: deduped_exposures

SCHEMA:
  app_id          String
  environment_id  String            -- run-implied; carried for per-Environment dashboard filtering
  experiment_id   String
  run_id          String
  variant         String            -- may be '__multiple__'
  entity_count    UInt64

-- Selection: rows where variant != '__multiple__' for SRM; '__multiple__' rows feed conflict_rate
```

Enables fast SRM chi-square computation: fetch `entity_count` per arm per run, compare against `declared_allocation`.

### Copy 2: Activation rate (`cp_activation_rate`)

```
pipe: cp_activation_rate
COPY_MODE: replace
SOURCE: deduped_exposures joined to serve_deduped_activations

SCHEMA:
  app_id          String
  environment_id  String            -- run-implied; carried for per-Environment dashboard filtering
  experiment_id   String
  run_id          String
  variant         String
  exposed_count   UInt64
  activated_count UInt64   -- earliest activation_ts > first_exposure_ts
```

The Activation serving source returns one retry-deduplicated candidate per distinct `activation_ts`
and counterfactual kind. The Exposure join rejects candidates at or before `first_exposure_ts`, then
selects the earliest remaining timestamp per Entity and Run. Physical retries cannot inflate the
numerator, pre-Exposure candidates cannot hide a later valid Activation, and late arrival remains
visible. The replace-mode target enables fast per-arm activation-rate reads for the bias guardrail
dashboard.

## Freshness SLA

| Layer                                 | Latency                                                                | Correctness                          |
| ------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| Raw ingest (`raw_events`)             | Near-real-time (Workers → Tinybird Events API)                         | Always correct (raw is truth)        |
| Snapshot (`deduped_exposures`)        | Up to 1 hour stale                                                     | Correct — tail covers the gap        |
| Activation/Metric/Web state           | Near-real-time with acknowledged materialization                       | Correct through explicit state merge |
| Serving queries                       | Tail covers since last snapshot; ~1h lag for bulk + real-time for tail | Always correct                       |
| `cp_srm_counts`, `cp_activation_rate` | Snapshot cadence (~1h)                                                 | Replace after successful snapshot    |

## Sources

- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — raw log, system of record, replayability
- [ADR-0017](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md) — Tinybird as analytics system; ordered replace-mode rollups
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — Exposure lambda architecture, Activation state, and replace-mode rollups
- [ADR-0045](../../adr/0045-metric-and-web-retry-dedup-uses-aggregate-state-materialization.md) — Metric/Web aggregate-state retry dedup
- [Snowplow deduplication](https://docs.snowplow.io/docs/modeling-your-data/modeling-your-data-with-dbt/package-mechanics/deduplication/) — at-least-once delivery and downstream earliest-timestamp dedup
- [BigQuery streaming inserts](https://docs.cloud.google.com/bigquery/docs/streaming-data-into-bigquery) — best-effort ingest dedup is not the analysis authority
- [Snowflake QUALIFY](https://docs.snowflake.com/en/sql-reference/constructs/qualify) — first-row window filtering pattern
