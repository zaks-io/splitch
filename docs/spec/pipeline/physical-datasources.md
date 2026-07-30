# Physical Tinybird datasources: experiment facts, Metric Events, Web Events, and retention

Pins the Tinybird datasource shapes: the Exposure/Activation raw log, the deduped first-touch
snapshot, the separate Metric Event and Web Event logs, and retention. The dedup/serving/MV layer
that derives from Exposure facts lives in [physical-dedup-pipes.md](./physical-dedup-pipes.md).
ADR-0024 lambda architecture; ADR-0017 Tinybird as analytics system of record.

## Raw events datasource (`raw_events`)

```
datasource: raw_events
ENGINE: MergeTree
ENGINE_PARTITION_KEY: toYYYYMM(server_received_at)
ENGINE_SORTING_KEY: app_id, environment_id, experiment_id, run_id, server_received_at, targeting_key_hash

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
  server_received_at   DateTime64(3)           -- UTC, milliseconds
  ingest_ts            DateTime64(3)           -- raw-log append timestamp, used only for snapshot watermarks
  client_timestamp     DateTime64(3)
  dedup_key            String                  -- configured as Tinybird dedup_key
  source_id            String                  -- POP identifier
  is_holdover          UInt8                   -- exposure rows: 1 = holdover replay, 0 = fresh assign; activation rows: 0
  activation_ts        Nullable(DateTime64(3)) -- activation rows: equals server_received_at; exposure rows: NULL
  counterfactual       UInt8                   -- 0 by default; 1 when SDK counterfactual path fires (deferred)
  sdk_version          Nullable(String)

DEDUP_KEY: dedup_key
```

**Partitioning by month** keeps per-month scans fast and enables TTL-based retention. Sorting by `(app_id, environment_id, experiment_id, run_id, server_received_at, targeting_key_hash)` makes per-environment, per-experiment, per-run queries efficient.

The `type` discriminator on a single datasource (not two tables) keeps the activation JOIN query simple and avoids coordination overhead. Both row types share `app_id`, `environment_id`, `experiment_id`, `run_id`, `id_type`, `targeting_key_hash` — the fields the dedup and gate queries join on.

The `dedup_key` column is the wire-level sha256 idempotency key (at-least-once ingest)
over `(type, app_id, experiment_id, run_id, id_type, targeting_key_hash, source_id, event_id)`.
The canonical first-touch identity is the tuple resolved by `MIN(server_received_at)` at query
time, defined in [exposure-event-contract.md](./exposure-event-contract.md).

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
  watermark_ts    DateTime64(3)        -- max raw_events.ingest_ts included in this snapshot
```

This is the Copy Pipe target. **Only deduped first-touch rows live here** — one row per `(app_id, environment_id, experiment_id, run_id, targeting_key_hash)` (`environment_id`, `experiment_id`, and `id_type` are run-implied carry-through columns; the dedup determinant is `(targeting_key_hash, run_id)`). Rollup MVs hang off this datasource, never off `raw_events`. The Copy Pipe, serving UNION, and MVs that populate and read this datasource are specified in [physical-dedup-pipes.md](./physical-dedup-pipes.md).

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
  ingest_ts                  DateTime64(3)

DEDUP_KEY: dedup_key
```

`fields` and `dimensions` are canonical JSON objects that already passed the immutable accepting
version. Analysis reads values through the Event Definition Version's declared named types, never
through caller-authored JSON paths. This datasource has no Experiment, Run, or Variant column:
those are joined from the first-touch Exposure set only when Entity scope is compatible.

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
  ingest_ts                   DateTime64(3)

DEDUP_KEY: dedup_key
```

`capture_source` is a validated advisory source key: `manual`, `page_view`, `web_vital`, or
`browser_error` in V1. Public SDK methods stamp it, but a direct Client Key HTTP caller can report
any supported value. `trace_id` and `span_id` are either both null or a validated non-zero W3C pair.
They provide correlation with an external trace store; they do not make `web_events` a span store.

`id_type` and `targeting_key_hash` are either both null for an anonymous Web Event or both present
for an explicitly Entity-identified event. The raw Targeting Key is never stored. `fields` and
`dimensions` are canonical JSON objects validated against the immutable accepting Event Definition
Version.

The sorting key follows the Web Analytics read path: mandatory App and Environment scope first,
low-cardinality capture source next, then canonical time. High-cardinality Event Definition and Web
Session identifiers follow those selective filters.

## Event-log retention TTL

```
-- Applied to raw_events datasource
TTL: server_received_at + INTERVAL {retention_days} DAY  -- default: 90 days

-- Applied independently to metric_events datasource
TTL: server_received_at + INTERVAL {retention_days} DAY  -- default: 90 days

-- Applied independently to web_events datasource
TTL: server_received_at + INTERVAL {web_retention_days} DAY  -- default: 30 days

-- Rationale: snapshot is the analysis source; raw log only needed for replay window
-- (re-run dedup when rules change) and for the real-time tail
-- 90 days covers any reasonable rule-change replay. Tunable.
```

Once the snapshot is authoritative (Copy Pipe running), the raw log's role is tail + replay. 90 days is the default; it is a policy dial, not a correctness one — longer retention enables older re-runs. Retention must exceed the maximum promised analysis replay window; otherwise old measurement edits cannot be recomputed from raw truth.

Metric Event rows have no deduped snapshot substitute, so their retention must cover the longest
promised Conversion Window and replay window. A deployment must reject a configuration whose
retention is shorter than either promise. Event Definition Version metadata remains available for at
least as long as any row stamped with it.

Web Event retention is independent because Web Events are higher-volume exploratory facts and are
not Experiment inputs. Its default is 30 days and it may be configured within plan limits without
regard to Conversion Windows or Experiment replay. An immutable Event Definition Version remains
available for at least as long as any retained Web Event row references it.

## Sources

- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — raw log, system of record, replayability
- [ADR-0017](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md) — Tinybird as analytics system
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — lambda architecture; raw vs snapshot roles
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
