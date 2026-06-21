# Physical Tinybird datasources — raw log, deduped snapshot, retention

Pins the Tinybird datasource shapes: the raw append-only log, the deduped first-touch snapshot, and the raw-log retention TTL. The dedup/serving/MV layer that derives from these lives in [physical-dedup-pipes.md](./physical-dedup-pipes.md). ADR-0024 lambda architecture; ADR-0017 Tinybird as analytics system of record.

## Raw events datasource (`raw_events`)

```
datasource: raw_events
ENGINE: MergeTree
ENGINE_PARTITION_KEY: toYYYYMM(server_ts)
ENGINE_SORTING_KEY: app_id, experiment_id, run_id, server_ts, targeting_key

SCHEMA:
  type            String               -- 'exposure' | 'activation'
  app_id          String               -- data-isolation key; mandatory, non-defaulted
  experiment_id   String
  run_id          String
  id_type         String
  targeting_key   String
  variant         Nullable(String)     -- present on 'exposure' rows; NULL on 'activation' rows
  server_ts       DateTime64(3)        -- UTC, milliseconds
  client_ts       Nullable(DateTime64(3))
  dedup_key       String               -- configured as Tinybird dedup_key
  source_id       String               -- POP identifier
  is_holdover     UInt8                -- 1 = holdover replay; 0 = fresh assign
  activation_ts   Nullable(DateTime64(3)) -- present on 'activation' rows; NULL on 'exposure' rows
  counterfactual  UInt8                -- 0 in v1; 1 when SDK counterfactual path fires (deferred)
  sdk_version     Nullable(String)

DEDUP_KEY: dedup_key
```

**Partitioning by month** keeps per-month scans fast and enables TTL-based retention. Sorting by `(app_id, experiment_id, run_id, server_ts, targeting_key)` makes per-experiment, per-run queries efficient.

The `type` discriminator on a single datasource (not two tables) keeps the activation JOIN query simple and avoids coordination overhead. Both row types share `app_id`, `experiment_id`, `run_id`, `id_type`, `targeting_key` — the fields the dedup and gate queries join on.

The `dedup_key` column is the wire-level sha256 idempotency key (at-least-once ingest); the canonical first-touch identity is the tuple resolved by `MIN(server_ts)` at query time, defined in [exposure-event-contract.md](./exposure-event-contract.md).

## Deduped exposures snapshot datasource (`deduped_exposures`)

```
datasource: deduped_exposures
ENGINE: MergeTree
ENGINE_SORTING_KEY: app_id, experiment_id, run_id, variant, targeting_key

SCHEMA:
  app_id          String
  experiment_id   String
  run_id          String
  id_type         String
  targeting_key   String
  variant         String               -- may be '__multiple__'
  first_exposure_ts  DateTime64(3)
  snapshot_ts     DateTime64(3)        -- when this snapshot was written; for tail cutoff calculation
```

This is the Copy Pipe target. **Only deduped first-touch rows live here** — one row per `(app_id, experiment_id, run_id, targeting_key)`. Rollup MVs hang off this datasource, never off `raw_events`. The Copy Pipe, serving UNION, and MVs that populate and read this datasource are specified in [physical-dedup-pipes.md](./physical-dedup-pipes.md).

## Raw log retention TTL

```
-- Applied to raw_events datasource
TTL: server_ts + INTERVAL {retention_days} DAY  -- default: 90 days

-- Rationale: snapshot is the analysis source; raw log only needed for replay window
-- (re-run dedup when rules change) and for the real-time tail
-- 90 days covers any reasonable rule-change replay. Tunable.
```

Once the snapshot is authoritative (Copy Pipe running), the raw log's role is tail + replay. 90 days is the default; it is a policy dial, not a correctness one — longer retention enables older re-runs.

## Sources

- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — raw log, system of record, replayability
- [ADR-0017](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md) — Tinybird as analytics system
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — lambda architecture; raw vs snapshot roles
