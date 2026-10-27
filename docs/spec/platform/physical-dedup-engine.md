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
  app_id, environment_id, experiment_id, run_id, id_type, entity_family_hash,
  argMin(targeting_key_hash, exposure_at) AS targeting_key_hash,
  MIN(exposure_at) AS first_exposure_ts,
  if(countIf(isNull(variant)) > 0 OR countDistinct(variant) > 1,
     '__multiple__', max(assumeNotNull(variant))) AS variant
FROM raw_events
WHERE type = 'exposure'
  AND ingest_ts <= {snapshot_watermark_ts}
GROUP BY app_id, environment_id, experiment_id, run_id, id_type, entity_family_hash
```

The sketch omits privacy joins and sticky snapshot merging; the committed Copy Pipe is authoritative.
`entity_family_hash` collapses compatible retained identity spellings, while `targeting_key_hash`
carries the representative first-touch hash. Both layers use `MIN(exposure_at)` for first-touch and the same conflict-aware aggregate that emits
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
  targeting_key_hash: string    // required, representative HMAC-derived Entity identity
  entity_family_hash: string    // required, canonical Entity family across retained spellings
  id_type:          string    // required
  variant:          string    // required — '__multiple__' if conflict
  first_exposure_ts: datetime  // required, sticky earliest encounter
  first_ingest_ts: datetime    // required, sticky earliest ingestion for SRM ordering
  activation_ingest_ts: datetime // required, sticky eligibility clock; epoch means unset
  snapshot_ts: datetime        // required, copy execution time
  watermark_ts:     datetime  // required — inclusive ingest boundary captured at snapshot start
}
```

The inclusive boundary puts rows at `watermark_ts` in both layers so final UNION dedup can collapse
the overlap instead of risking a missed boundary row.

`ENGINE_SORTING_KEY`:
`(app_id, environment_id, experiment_id, run_id, variant, entity_family_hash)`. `app_id` is first for
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

## Implemented serving path

The lambda layer is implemented in `infra/tinybird/copies/cp_deduped_exposures.pipe` and
`infra/tinybird/pipes/serve_deduped_exposures.pipe`. The Analysis Worker triggers the on-demand
replace Copy Pipe hourly with `copy_watermark_ts`; shared preview disables the scheduled trigger.

The Copy Pipe does not discard prior snapshot evidence when raw rows expire. It merges retained
raw evidence with its previous snapshot and carries forward previous-only membership. Earliest
encounter and ingestion clocks remain sticky, an existing `__multiple__` quarantine cannot clear,
and activated-SRM eligibility survives expiry of the original raw pair. Generation tombstones
exclude destroyed App identity epochs from both inputs.

The serving pipe performs these steps:

1. Read snapshot rows scoped by App, Environment, Experiment, and Run, excluding Entity deletion
   cutoffs and destroyed identity generations.
2. Read raw Exposure rows at or after the App/Environment snapshot watermark, with the same scope
   and privacy filters. A pinned `ingest_watermark_ts` also bounds both layers above.
3. UNION both layers and dedup again by `(app_id, environment_id, experiment_id, run_id, id_type,
entity_family_hash)`. Keep the earliest encounter and ingestion clocks, preserve quarantine,
   and carry the snapshotted eligibility clock.

The snapshot is retained analysis evidence, not a disposable cache. A rebuild from retained raw
alone cannot recover membership whose raw Exposure has expired. Backup and repair procedures must
preserve that evidence; see [tinybird-backup-export.md](./tinybird-backup-export.md).

## Raw log TTL

The raw Exposure log has a 90-day TTL on `server_received_at`. The snapshot retains membership
beyond that window. Results that need expired Metric Event or Activation outcomes fail loud rather
than turning expired facts into zeros; see [privacy-data-lifecycle.md](./privacy-data-lifecycle.md).

## Sources

- [../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
