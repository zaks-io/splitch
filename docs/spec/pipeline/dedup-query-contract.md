# Dedup query contract — first-touch, `__multiple__` quarantine, SRM denominator

The canonical first-touch dedup query is the **single place** where first-touch, the `__multiple__` quarantine, the SRM denominator, and the Conversion Window anchor are all defined. One definition, never hand-copied (ADR-0005, ADR-0010).

## Inputs

- `raw_events` rows with `type = 'exposure'` (see [exposure-event-contract.md](./exposure-event-contract.md))
- Scoped to one `app_id` (mandatory, non-defaulted — injected by the analytics proxy, never defaulted)
- Optionally scoped to `experiment_id` and/or `run_id`

## Canonical first-touch query

```sql
-- Produces one row per (targeting_key_hash, run_id).
-- This is the analysis unit: the deduped denominator.
SELECT
  app_id,
  environment_id,
  experiment_id,
  run_id,
  id_type,
  targeting_key_hash,
  MIN(server_received_at)                                        AS first_exposure_ts,
  CASE
    WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__'
    ELSE MAX(variant)
  END                                                   AS variant
FROM raw_events
WHERE type = 'exposure'
  AND app_id = {app_id: String}              -- mandatory
GROUP BY app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash
```

The dedup determinant is `(targeting_key_hash, run_id)`: a Run belongs to exactly one Experiment
in exactly one Environment with one declared Entity type, so `app_id`, `environment_id`,
`experiment_id`, and `id_type` are functionally determined by `run_id`. They appear in the
`GROUP BY` so they pass through to the output as carried scope columns, not because they change
which rows collapse. `environment_id` is in the tuple because Exposures are per-Environment
(ADR-0027) and downstream consumers filter by it; it does not split first-touch.

### Invariants

1. `server_received_at` is the canonical timestamp for ordering (monotonic, no client clock skew). `client_timestamp` is never used in the dedup.
2. `MIN(server_received_at)` per `(targeting_key_hash, run_id)` determines first-touch. Late-arriving events with earlier `server_received_at` are incorporated on the next query run — this is correct per ADR-0010 (replayability).
3. `COUNT(DISTINCT variant) > 1` within one `(targeting_key_hash, run_id)` produces `variant = '__multiple__'`. Given pure `assign()` + authoritative holdover DO + material-edit-opens-new-Run, a variant conflict within one Run is always a defect (config race, SDK bug, or ADR-0003 violation) and must be surfaced loudly, not silently resolved.
4. The query is fully replayable over the complete raw log. Changing the dedup rule (e.g., adding a filter) means rerunning the query — no migration of raw data.

## `__multiple__` handling

| Population                  | Included in SRM denominator? | Included in analysis arms? | Reported separately?                           |
| --------------------------- | ---------------------------- | -------------------------- | ---------------------------------------------- |
| `variant != '__multiple__'` | YES                          | YES                        | —                                              |
| `variant = '__multiple__'`  | NO                           | NO                         | YES — as `variant_conflict_rate` health metric |

`variant_conflict_rate` = `COUNT(*) WHERE variant = '__multiple__'` / `COUNT(*)` per `(run_id)`. Threshold: ~1% triggers an alert; above that signals a real defect.

## SRM denominator shape

```sql
-- Input to chi-square SRM test (per arm vs declared allocation)
SELECT
  run_id,
  variant,
  COUNT(DISTINCT targeting_key_hash)   AS observed_count
FROM <dedup_output>
WHERE variant != '__multiple__'
GROUP BY run_id, variant
```

This is compared against the Run's `declared_allocation` per Variant. One denominator definition everywhere — SRM, Metrics, and Conversion Window anchor all use the same deduped output, never a separate raw-count denominator.

## Physical placement

The dedup query lives in two places (ADR-0024 lambda architecture), both generated from this shared definition:

1. **Copy Pipe** — the batch layer; runs on schedule, writes result to the `deduped_exposures` snapshot datasource.
2. **Real-time tail query** — reads raw rows since the last snapshot and applies the same dedup logic inline.

Serving pipes `UNION ALL` the snapshot with the tail result and re-dedup the union (tail rows may overlap with the snapshot boundary). See [physical-dedup-pipes.md](./physical-dedup-pipes.md).

## Composition with activation gate

The dedup output (`first_exposure_ts`, `variant`) is the direct input to the activation gate JOIN. See [activation-gate-query-contract.md](./activation-gate-query-contract.md).

## Stats engine handoff

The dedup output feeds the stats engine as per-Entity rows:

```
{ app_id, environment_id, targeting_key_hash, run_id, variant, first_exposure_ts }
```

For Ratio Metrics the stats engine also needs the per-Entity numerator/denominator pair. Delta-method covariance is not recoverable after aggregation. That pair is delivered by metric-specific queries that GROUP BY `targeting_key_hash`, not pre-aggregated here.

## Sources

- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md) — pipeline-authoritative, one centralized dedup definition
- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — first-touch query, MIN(ts), replayability
- [ADR-0011](../../adr/0011-conflicting-variant-entities-quarantined-to-multiple.md) — `__multiple__` quarantine rule
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — lambda architecture, shared dedup definition
- [exposure-pipeline-seam.md](../../architecture/exposure-pipeline-seam.md) — dedup query centralization
