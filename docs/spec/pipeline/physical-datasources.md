# Physical Tinybird datasources: experiment facts, Metric Events, Web Events, and retention

Pins the Tinybird datasource shapes: the Exposure/Activation raw log, the separate Metric Event and
Web Event logs, Activation/Metric/Web aggregate-state targets, and retention. The physical serving
layer lives in [physical-dedup-pipes.md](./physical-dedup-pipes.md). ADR-0024 defines Exposure
first-touch snapshot-plus-tail dedup and Activation state; ADR-0045 defines continuous
aggregate-state retry dedup for Metric and Web Events.

## Raw events datasource (`raw_events`)

```
datasource: raw_events
ENGINE: MergeTree
ENGINE_PARTITION_KEY: toYYYYMM(ingest_ts)
ENGINE_SORTING_KEY: app_id, environment_id, ingest_ts, experiment_id, run_id, exposure_at, targeting_key_hash

SCHEMA:
  type                 String                  -- 'exposure' | 'activation'
  app_id               String                  -- data-isolation key; mandatory, non-defaulted
  environment_id       String                  -- co-scoped with app_id; per-Environment (ADR-0027)
  experiment_id        String
  run_id               String
  id_type              String
  targeting_key_hash   String
  variant              Nullable(String)        -- present on 'exposure' rows; NULL on 'activation' rows
  event_id             String                  -- retry-stable physical row id, generated before any retry
  exposure_at          DateTime64(3)           -- canonical Exposure encounter time; activation rows equal server_received_at
  server_received_at   DateTime64(3)           -- UTC, milliseconds
  ingest_ts            DateTime64(3) `json:$.ingest_ts` DEFAULT now64(3)
  client_timestamp     Nullable(DateTime64(3))
  dedup_key            String                  -- Splitch retry identity; Tinybird does not enforce uniqueness
  source_id            String                  -- POP identifier
  is_holdover          UInt8                   -- exposure rows: 1 = holdover replay, 0 = fresh assign; activation rows: 0
  activation_ts        Nullable(DateTime64(3)) -- activation rows: equals server_received_at; exposure rows: NULL
  counterfactual       UInt8                   -- 0 by default; 1 when SDK counterfactual path fires (deferred)
  sdk_version          Nullable(String)

# DEDUP_KEY=dedup_key                         -- Splitch contract marker; ignored by Tinybird
```

Partitioning by insertion month and sorting by `(app_id, environment_id, ingest_ts, ...)` make the
tenant-scoped real-time tail prune to post-snapshot parts and primary-key ranges. This is the normal
raw serving access path. `exposure_at` is the Exposure analysis clock; `server_received_at` remains the TTL column;
replay and repair are bounded offline paths, not a reason to make every live tail scan retained
event-time partitions.

The `type` discriminator on a single datasource (not two tables) keeps the activation JOIN query simple and avoids coordination overhead. Both row types share `app_id`, `environment_id`, `experiment_id`, `run_id`, `id_type`, `targeting_key_hash` — the fields the dedup and gate queries join on.

The producer omits `ingest_ts`; Tinybird assigns the physical insertion timestamp used by the
snapshot watermark. This prevents Queue delay or manual replay from preserving a stale
pre-publication watermark. The JSONPath precedes `DEFAULT` for valid datasource-file syntax.

The `dedup_key` column is the wire-level sha256 idempotency key (at-least-once ingest)
over `(type, app_id, experiment_id, run_id, id_type, targeting_key_hash, source_id, event_id)`.
The `DEDUP_KEY` comment is repository metadata consumed by Splitch contract tests, not a Tinybird
datasource instruction or uniqueness guarantee.
The canonical first-touch identity is the tuple resolved by `MIN(exposure_at)` at query time,
defined in [exposure-event-contract.md](./exposure-event-contract.md).

## Deduped exposures snapshot datasource (`deduped_exposures`)

```
datasource: deduped_exposures
ENGINE: MergeTree
ENGINE_SORTING_KEY: app_id, environment_id, experiment_id, run_id, variant, targeting_key_hash

SCHEMA:
  app_id          String
  environment_id  String               -- co-scoped with app_id; per-Environment (ADR-0027)
  experiment_id   String
  run_id          String
  id_type         String
  targeting_key_hash String
  variant         String               -- may be '__multiple__'
  first_exposure_ts  DateTime64(3)
  snapshot_ts     DateTime64(3)        -- when this snapshot was written; metadata only
  watermark_ts    DateTime64(3)        -- inclusive ingest boundary captured at snapshot start
```

The inclusive boundary puts rows at `watermark_ts` in both the snapshot and tail so final serving
dedup can collapse the overlap instead of risking a missed boundary row.

This is the replace-mode Copy Pipe target. **Only deduped first-touch rows live here** — one row per
`(app_id, environment_id, experiment_id, run_id, targeting_key_hash)` (`environment_id`,
`experiment_id`, and `id_type` are run-implied carry-through columns; the dedup determinant is
`(targeting_key_hash, run_id)`). Ordered replace-mode rollup Copy Pipes rebuild from this completed
snapshot. No materialized view attaches to this datasource or `raw_events`. The snapshot, serving
UNION, and rollup contracts are specified in
[physical-dedup-pipes.md](./physical-dedup-pipes.md).

## Deduped Activation state (`deduped_activations_state`)

```text
datasource: deduped_activations_state
ENGINE: AggregatingMergeTree
ENGINE_PARTITION_KEY: toYYYYMM(event_date)
ENGINE_SORTING_KEY: app_id, environment_id, run_id, event_date, counterfactual, experiment_id, id_type, targeting_key_hash, activation_ts

SCHEMA:
  app_id               String
  environment_id       String
  experiment_id        String
  run_id                String
  event_date            Date
  id_type               String
  targeting_key_hash    String
  counterfactual        UInt8
  activation_ts         DateTime64(3)
  activation_state      AggregateFunction(min, DateTime64(3))

BACKFILL skip
```

The Activation materialized Pipe filters `raw_events` to `type = 'activation' AND activation_ts IS
NOT NULL`, converts the already-filtered timestamp with `assumeNotNull`, groups each inserted block by
the complete sorting key, and writes `minState(assumeNotNull(activation_ts))`. Event Ingest rejects a
missing Activation timestamp before append; the physical filter also keeps the state column's type
exactly non-null. Physical retries and multiple parts remain mergeable. `serve_deduped_activations`
filters by injected App, Environment, exact Run, half-open `event_date` and `activation_ts` bounds, and
counterfactual policy before applying `minMerge(activation_state)` per
`(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash, counterfactual,
activation_ts)`. It returns one logical candidate per distinct timestamp and counterfactual kind so
analysis can reject pre-Exposure candidates before choosing the earliest valid Activation. A late
delivery is written to its original activation-time partition and remains visible whenever its event
time belongs to the requested Run window. No gated analysis or Exposure rollup scans raw Activation
rows.

## Metric Events datasource (`metric_events`)

```text
datasource: metric_events
ENGINE: MergeTree
ENGINE_PARTITION_KEY: toYYYYMM(server_received_at)
ENGINE_SORTING_KEY: app_id, environment_id, event_definition_id, server_received_at, id_type, targeting_key_hash

SCHEMA:
  dedup_key                  String
  event_id                   String
  app_id                     String
  environment_id             String
  event_definition_id        String
  event_definition_version_id String
  event_name                 String
  id_type                    LowCardinality(String)
  targeting_key_hash         String
  fields                     String
  dimensions                 String
  server_received_at         DateTime64(3)
  ingest_ts                  DateTime64(6) `json:$.ingest_ts` DEFAULT now64(6)

# DEDUP_KEY=dedup_key                         -- Splitch contract marker; ignored by Tinybird
```

`fields` and `dimensions` are canonical JSON objects that already passed the immutable accepting
version. Analysis reads values through the Event Definition Version's declared named types, never
through caller-authored JSON paths. This datasource has no Experiment, Run, or Variant column:
those are joined from the first-touch Exposure set only when Entity scope is compatible.
The producer omits `ingest_ts`; Tinybird assigns this physical insertion timestamp. The JSONPath must
precede `DEFAULT` in the datasource schema so NDJSON rows that omit the field build and ingest
correctly.

### Metric retry state (`deduped_metric_events_state`)

```text
datasource: deduped_metric_events_state
ENGINE: AggregatingMergeTree
ENGINE_PARTITION_KEY: toYYYYMM(event_date)
ENGINE_SORTING_KEY: app_id, environment_id, event_date, id_type, event_definition_id, server_received_at, targeting_key_hash, dedup_key

SCHEMA:
  app_id                      String
  environment_id              String
  event_date                  Date
  event_definition_id         String
  id_type                     LowCardinality(String)
  server_received_at          DateTime64(3)
  targeting_key_hash          String
  dedup_key                   String
  canonical_state             AggregateFunction(argMin, Tuple(String, String, String, String, String, DateTime64(3), DateTime64(6)), DateTime64(6))

BACKFILL skip
```

`event_date` is `toDate(server_received_at)` in the materialized Pipe. The full timestamp is also a
grouping dimension so the state TTL exactly matches the raw row TTL and precise time bounds can filter
before `argMinMerge`. The canonical tuple order is
`(event_id, event_definition_version_id, event_name, fields, dimensions, server_received_at,
ingest_ts)` with the exact types declared above. The materialized Pipe groups each inserted block by
the complete sorting key and writes that tuple with `argMinState(..., ingest_ts)`. Exact retries have
the same event date, definition, Entity identity, and canonical content. Every Analysis Worker query reads
`serve_deduped_metric_events`, which filters by injected tenant, date, and precise event-time bounds,
applies `argMinMerge(canonical_state)` per retry key, and flattens only the required columns. The full
physical `metric_events` log is never a request-time dedup source.

## Web Events datasource (`web_events`)

```text
datasource: web_events
ENGINE: MergeTree
ENGINE_PARTITION_KEY: toYYYYMM(server_received_at)
ENGINE_SORTING_KEY: app_id, environment_id, capture_source, server_received_at, event_definition_id, session_id_hash

SCHEMA:
  dedup_key                   String
  event_id                    String
  app_id                      String
  environment_id              String
  event_definition_id         String
  event_definition_version_id String
  event_name                  String
  session_id_hash             String
  capture_source              LowCardinality(String)
  sdk_version                 String
  trace_id                    Nullable(String)
  span_id                     Nullable(String)
  id_type                     Nullable(LowCardinality(String))
  targeting_key_hash          Nullable(String)
  fields                      String
  dimensions                  String
  server_received_at          DateTime64(3)
  ingest_ts                   DateTime64(6) `json:$.ingest_ts` DEFAULT now64(6)

# DEDUP_KEY=dedup_key                         -- Splitch contract marker; ignored by Tinybird
```

`capture_source` is a validated advisory source key: `manual`, `page_view`, `web_vital`, or
`browser_error` in V1. Public SDK methods stamp it, but a direct Client Key HTTP caller can report
any supported value. `trace_id` and `span_id` are either both null or a validated non-zero W3C pair.
They provide correlation with an external trace store; they do not make `web_events` a span store.

`id_type` and `targeting_key_hash` are either both null for an anonymous Web Event or both present
for an explicitly Entity-identified event. The raw Targeting Key is never stored. `fields` and
`dimensions` are canonical JSON objects validated against the immutable accepting Event Definition
Version. The producer omits `ingest_ts`; Tinybird assigns this physical insertion timestamp. The
JSONPath precedes `DEFAULT` for valid datasource-file syntax.

### Web retry state (`deduped_web_events_state`)

```text
datasource: deduped_web_events_state
ENGINE: AggregatingMergeTree
ENGINE_PARTITION_KEY: toYYYYMM(event_date)
ENGINE_SORTING_KEY: app_id, environment_id, event_date, has_entity, capture_source, id_type_scope, event_definition_id, server_received_at, session_id_hash, targeting_key_hash_scope, dedup_key

SCHEMA:
  app_id                      String
  environment_id              String
  event_date                  Date
  capture_source              LowCardinality(String)
  event_definition_id         String
  has_entity                  UInt8
  id_type_scope               LowCardinality(String)
  server_received_at          DateTime64(3)
  targeting_key_hash_scope    String
  session_id_hash             String
  dedup_key                   String
  canonical_state             AggregateFunction(argMin, Tuple(String, String, String, String, Nullable(String), Nullable(String), String, String, DateTime64(3), DateTime64(6)), DateTime64(6))

BACKFILL skip
```

`event_date` is `toDate(server_received_at)` in the materialized Pipe. The full timestamp is also a
grouping dimension for exact raw/state TTL parity and bounded pre-merge filtering. The canonical tuple
order is
`(event_id, event_definition_version_id, event_name, sdk_version, trace_id, span_id, fields,
dimensions, server_received_at, ingest_ts)` with the exact types declared above. The materialized
Pipe normalizes anonymous identity to `has_entity = 0`, empty `id_type_scope`, and
empty `targeting_key_hash_scope`, avoiding nullable sorting-key dimensions. Serving reconstructs both
identity fields as null when `has_entity = 0` and otherwise uses the two scoped values. The Pipe groups
each inserted block by the complete sorting key and writes that tuple with
`argMinState(..., ingest_ts)`. Every Web Analytics read uses
`serve_deduped_web_events`, which filters by injected tenant, date, and precise event-time bounds,
applies `argMinMerge(canonical_state)` per retry key, and flattens only the required columns before
counts, session association, journey ordering, or percentile aggregation. The exact read ordering is defined in
[endpoints-web-analytics.md](../control-plane/endpoints-web-analytics.md#tinybird-query-contract).

The sorting key follows the Web Analytics read path: mandatory App, Environment, and partition date
first; low-cardinality Entity-presence, capture-source, and Entity-type dimensions next; then
Event Definition and precise event time; then high-cardinality Web Session, Entity hash, and retry
key.

## Event-log retention TTL

```
-- Applied to raw_events datasource
TTL: server_received_at + INTERVAL {retention_days} DAY  -- default: 90 days

-- Applied independently to metric_events datasource
TTL: server_received_at + INTERVAL {retention_days} DAY  -- default: 90 days

-- Applied independently to web_events datasource
TTL: server_received_at + INTERVAL {web_retention_days} DAY  -- default: 30 days

-- Applied independently to deduped_metric_events_state and deduped_web_events_state
TTL: server_received_at + INTERVAL {matching_family_retention_days} DAY

-- Applied to deduped_activations_state
TTL: activation_ts + INTERVAL {retention_days} DAY

-- Rationale: full-timestamp TTL keeps raw and state expiry exact; raw logs remain replay truth
-- 90 days covers any reasonable rule-change replay. Tunable.
```

Once materialization is authoritative, the raw log's role is replay and reconciliation. 90 days is
the default; it is a policy dial, not a correctness one. Longer retention enables older re-runs.
Retention must exceed the maximum promised analysis replay window; otherwise old measurement edits
cannot be recomputed from raw truth.

Metric Event raw and state retention must both cover the longest promised Conversion Window and
replay window. A deployment rejects either retention when it is shorter than those promises. Event
Definition Version metadata remains available for at least as long as any retained raw or state row
stamped with it.

Web Event raw and state retention are independent because Web Events are higher-volume exploratory
facts and are not Experiment inputs. Their shared default is 30 days and may be configured within
plan limits without regard to Conversion Windows or Experiment replay. An immutable Event Definition
Version remains available for at least as long as any retained raw or state row references it.

## Sources

- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — raw log, system of record, replayability
- [ADR-0017](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md) — Tinybird as analytics system
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — lambda architecture; raw vs snapshot roles
- [ADR-0045](../../adr/0045-metric-and-web-retry-dedup-uses-aggregate-state-materialization.md) — Metric/Web aggregate-state retry dedup
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
