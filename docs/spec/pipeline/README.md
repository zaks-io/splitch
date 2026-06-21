# Pipeline area spec

**Spine:** Raw Exposure and Activation events flow from five edge runtimes into an append-only log (Tinybird). First-touch dedup is a replayable query at analysis time, never a collapse at ingest. The dedup output is the single denominator for SRM, Metrics, and the Conversion Window anchor. The Activation gate composes onto the dedup as a JOIN. The Assignment Store DO write is driven eagerly on apparent first-touch for sticky experience, while the raw log is the authority for analysis.

## Files

| File | Purpose |
|---|---|
| [exposure-event-contract.md](./exposure-event-contract.md) | Canonical field list for Exposure and Activation rows on the unified `raw_events` log; dedup key definition; non-exposing paths (peek, test-eval) |
| [dedup-query-contract.md](./dedup-query-contract.md) | The one canonical first-touch dedup query; `__multiple__` quarantine rule; SRM denominator shape; stats engine handoff contract |
| [activation-gate-query-contract.md](./activation-gate-query-contract.md) | Activation gate JOIN query; ordering invariant (`activation_ts > first_exposure_ts`); window anchor re-definition; two bias guardrails (activated-population SRM + per-arm activation rate) |
| [edge-ingest-contract.md](./edge-ingest-contract.md) | Five-runtime ingest contract; at-least-once delivery; timestamp sourcing; `run_id`/`id_type`/`app_id` injection rules; holdover write trigger; ingest failure modes |
| [physical-datasources.md](./physical-datasources.md) | Tinybird datasource column lists (`raw_events`, `deduped_exposures`); raw-log retention TTL |
| [physical-dedup-pipes.md](./physical-dedup-pipes.md) | Copy Pipe definition; serving snapshot+tail UNION query; v1 rollup MVs (`mv_srm_counts`, `mv_activation_rate`); freshness SLA |
| [holdover-write-contract.md](./holdover-write-contract.md) | Pipeline → Assignment Store DO write; `putIfAbsent` semantics; KV write-through; timing (non-blocking in `ctx.waitUntil`); failure contract; port seam definition |

## Key invariants

1. **ELT, not ETL.** Raw log is append-only and the system of record. Dedup is query-time, replayable. Never collapse at ingest.
2. **One dedup definition.** The Copy Pipe and the real-time tail query are generated from one shared Jinja template. Drift is a correctness failure.
3. **Rollup MVs off snapshot only.** Attaching an AggregatingMergeTree MV to `raw_events` leaks redundant edge events into rollup counts. MVs attach to `deduped_exposures`.
4. **`__multiple__` is fail-loud.** Variant conflict within a Run quarantines the Entity — never silently first-touch-wins.
5. **Activation gate is a composed JOIN, not a separate pipeline.** Dedup output → activation JOIN → `window_anchor`. Gate scope is per-Run binary; Activation Metric definition is frozen per Run.
6. **Two authorities, two jobs.** DO = experience (sticky holdover). Raw log + dedup = analysis (denominator). They can momentarily disagree; that is accepted and self-healing.

## Sources (primary)

- ADRs 0004, 0005, 0009, 0010, 0011, 0012, 0013, 0017, 0024
- [exposure-pipeline-seam.md](../../architecture/exposure-pipeline-seam.md)
- [activation-gate-seam.md](../../architecture/activation-gate-seam.md)
