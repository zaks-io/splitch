# Pipeline area spec

**Spine:** Raw Exposure and Activation events flow from five edge runtimes into an append-only log
(Tinybird). Metric Events flow through the same Event Ingest Worker into a separate App/Environment/
Entity fact log. First-touch dedup is a replayable query at analysis time, never a collapse at
ingest. The dedup output is the single denominator for SRM, Metrics, and the Conversion Window
anchor. Metric Events supply values, never the denominator. The Activation gate composes onto the
dedup as a JOIN. Web Events use Web Sessions for exploratory browser journeys and never feed
Experiment measurement. The Assignment Store DO write is driven eagerly on apparent first-touch
for sticky experience, while the raw log is the authority for analysis.

## Files

| File                                                                     | Purpose                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [exposure-event-contract.md](./exposure-event-contract.md)               | Canonical field list for Exposure and Activation rows on the unified `raw_events` log; dedup key definition; non-exposing paths (peek, test-eval)                                           |
| [metric-event-contract.md](./metric-event-contract.md)                   | SDK `track()` and `POST /api/sdk/events`; Event Definition Version resolution; validation/no-write ordering; idempotency; analysis compatibility                                            |
| [web-event-identity.md](./web-event-identity.md)                         | Batch-only `/api/sdk/web-events`; per-item retry identity; required Web Session; optional Entity identity; anonymous-to-identified journey boundary; Experiment exclusion                   |
| [dedup-query-contract.md](./dedup-query-contract.md)                     | The one canonical first-touch dedup query; `__multiple__` quarantine rule; SRM denominator shape; stats engine handoff contract                                                             |
| [activation-gate-query-contract.md](./activation-gate-query-contract.md) | Activation gate JOIN query; ordering invariant (`activation_ts > first_exposure_ts`); window anchor re-definition; two bias guardrails (activated-population SRM + per-arm activation rate) |
| [edge-ingest-contract.md](./edge-ingest-contract.md)                     | Five-runtime ingest contract; current direct-write debt; target admission, durable acceptance/outbox, datasource queues, fixed Tinybird drain governor, DLQ isolation, and failure modes    |
| [physical-datasources.md](./physical-datasources.md)                     | Tinybird raw, Exposure snapshot, Activation/Metric/Web aggregate-state schemas, sorting/partition keys, and matching retention                                                              |
| [physical-dedup-pipes.md](./physical-dedup-pipes.md)                     | Exposure snapshot+tail; Activation and Metric/Web aggregate states; replace-mode Exposure rollups; Tinybird performance and repair gates                                                    |
| [holdover-write-contract.md](./holdover-write-contract.md)               | Pipeline → Assignment Store DO write; `putIfAbsent` semantics; KV write-through awaited after the commit; failure contract; port seam definition                                            |

## Key invariants

1. **ELT, not ETL.** Raw logs are append-only replay truth. Exposure first-touch uses snapshot plus
   tail; Metric/Web retry collapse uses mergeable canonical-row states. Never mutate or collapse raw
   facts at ingest.
2. **One dedup definition.** The Copy Pipe and the real-time tail query are generated from one shared Jinja template. Drift is a correctness failure.
3. **Exposure rollups replace after snapshot.** Ordered replace-mode Copy Pipes rebuild rollups only
   after a successful Exposure snapshot. MVs are invalid for either raw retries or repeated snapshot
   replacement.
4. **`__multiple__` is fail-loud.** Variant conflict within a Run quarantines the Entity — never silently first-touch-wins.
5. **Activation gate is a composed JOIN, not a separate pipeline.** Dedup output → activation JOIN → `window_anchor`. Gate scope is per-Run binary; Activation Metric definition is frozen per Run.
6. **Two authorities, two jobs.** DO = experience (sticky holdover). Raw log + dedup = analysis (denominator). They can momentarily disagree; that is accepted and self-healing.
7. **Three event families stay separate.** Exposure/Activation, Metric Event, and Web Event shapes,
   routes, datasources, identity, retention, and consumers never collapse into one universal event.
8. **Accepted ingest is durable, not committed to Tinybird.** Claim-backed Metric/Web Events seal
   claim and payload atomically before `202`; a fresh Evaluation seals its Exposure before returning
   the Variant. Four isolated queues then microbatch to Tinybird under a fixed drain governor and
   write-ahead attempt guard.
9. **Metric/Web retry state is not a rollup.** Serving completes `argMinMerge` per retry key before
   counts, sums, percentiles, session association, or statistical aggregation.

## Sources (primary)

- ADRs 0004, 0005, 0009, 0010, 0011, 0012, 0013, 0017, 0024, 0043, 0045
- [exposure-pipeline-seam.md](../../architecture/exposure-pipeline-seam.md)
- [activation-gate-seam.md](../../architecture/activation-gate-seam.md)
