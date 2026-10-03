# Runs freeze an analysis version, and legacy Runs read under a labeled one

**Status:** accepted

Run Start freezes the assignment config and its hash, and the result token binds canonical stats
into Conclude evidence. Nothing recorded which analysis implementation a Run was started under, so
a deploy that changes how locked evidence is computed could change tokens, bounds, and breach
status for a Run whose raw facts never moved. Existing Runs also never committed a sequential
`target_n`, a planned duration, or an inference version, and pending Approval proposals bind
evidence produced by whatever engine was live. Every Phase 0 estimator change needs one rule for
all of this before it ships.

## Decision

Run Start freezes three commitments into the locked decision spec and the Run Snapshot
(ADR-0047), on both Start doors:

- `analysis_version`: the named analysis implementation (`CURRENT_ANALYSIS_VERSION`), stamped when
  the Run opens.
- `target_n`: the caller's sequential tuning target, or the 5000 default recorded with
  `target_n_source: "default"`. A fixed-horizon Run has none.
- `planned_duration_days`: seven days by default, at most 365. The policy is whole weeks; any other value needs
  a `plannedDurationOverrideReason`, which is recorded in the locked spec and shown in results.

The result token adds `analysisVersion` to its canonical input for a versioned Run, so a deliberate
version bump produces a different token for the same evidence. The Control Plane recomputes the
token from the D1 Run's version, so evidence read under any other version is not bound to the Run.

A Run started before these fields existed is a legacy Run. ADR-0047's no-backfill rule holds:

- A legacy Run with an analyzable snapshot is read under the labeled version
  `legacy-unversioned`, whose compatibility implementation is the engine as it stood when
  versioning began. Its token omits the version key, so it is byte-identical to its token before
  this change.
- A legacy snapshot lacking required evidence stays unavailable, exactly as ADR-0047 rules.
- Compatibility never invents a commitment. A legacy Run reports no `target_n` commitment and no
  planned duration, and the `planned_duration` gate check is `not_applicable` for it.

The decision gate gains a `planned_duration` check with its own id and failure code
(`DECISION_DURATION_INCOMPLETE`). It measures the selected evidence's observation window, the
watermark minus the Run start, never the wall clock. Day-one evidence cannot be concluded on day
seven. Analysis refuses a pinned watermark later than the ingested evidence watermark, so a caller
cannot claim a window that has not been observed. The watermark is the Environment's ingestion
boundary, so a Run that received no traffic for a week has still been observed for that week. This
is a default policy with a labeled override (plan decision D7), separate from burn-in.

Pending Approval proposals record the caller's intent (`targetN`, `plannedDurationDays`, the
override reason), not resolved values, and replay resolves them with the same function the direct
door uses. A proposal recorded before these fields existed resolves like a Start that omitted them.
The analysis version is not on the proposal: no evidence exists before Start, so a proposal applied
after a version change opens its Run under the version current at application.

Analysis supports an explicit set of versions. A snapshot frozen under any other version is refused
with a validation error rather than analyzed under a different engine. That is the rollback rule: a
Worker rolled back below a Run's version refuses that Run until it is rolled forward.

## Considered options

- Backfill legacy Runs with the current version, the default target, and a seven-day plan.
  Rejected because it records commitments the Runs never made and changes every legacy token.
- Put the version in every token, legacy included. Rejected because every Conclude prepared before
  the deploy would go stale at once with no change in evidence.
- Measure duration against the wall clock at Conclude. Rejected because a day-seven Conclude could
  then select day-one evidence.
- Make the duration floor an opt-in strict mode. Rejected per D7: one weekly cycle is the standard
  temporal-coverage recommendation, and the override is labeled rather than hidden.

## Consequences

- Bumping `CURRENT_ANALYSIS_VERSION` is how an estimator change ships. Runs already started keep
  their version and must keep a supported implementation, or stay refused, until a corrected
  reanalysis rule is written for that change.
- A corrected reanalysis of a known-invalid earlier decision is a separate, explicit act that
  supersedes the decision; it is not a silent re-read under a newer version. Its rule is still open.
- The `run_commitments` field on a ready results envelope is optional only so a Control Plane can
  read an older Analysis Worker during rollout. The Analysis Worker deploys first, so for a short
  window an older Control Plane parsing the strict envelope rejects the new field; results reads
  through it fail loud until the Control Plane deploys.
- `run_snapshots` gains nullable columns, so old rows read as legacy with no rewrite.

## Version table

Dispatch is one exhaustive switch over known versions. Unknown versions refuse. There is no
silent fallthrough to the newest.

| Version              | SRM gate (Exposure and activated)           | Family correction | Notes                                                                                           |
| -------------------- | ------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `legacy-unversioned` | Chi-square, mismatch at p < 0.001           | BH                | Compatibility implementation as of versioning start; token omits `analysisVersion`              |
| `analysis-v1`        | Chi-square, mismatch at p < 0.001           | BH                | First frozen version; same estimators as legacy                                                 |
| `analysis-v2`        | Sequential Dirichlet-multinomial martingale | BH                | Continuous-monitoring SRM. Keeps BH: ADR-0014 recorded BH stop FDR 0 (alpha 0.05), under target |

Activation-rate balance stays chi-square under every version until a sequential equality-of-rates
test is chosen. BH-G remains a typed comparator; it is not selected for analysis-v2 because the
recorded stop-at-first-crossing simulation did not show plain BH exceeding the FDR target.

## Sources

- [Conclusion and decision gate](../spec/control-plane/conclusion-and-winner-promotion.md)
- [Run commitments contract](../../packages/contracts/src/run-commitments.ts)
- [Planned-duration check](../../packages/contracts/src/experiment-decision-gate-duration.ts)
- [Start resolver](../../apps/control-plane-api/src/experiment-start-commitments.ts)
- [Run Snapshot bridge](0047-run-inputs-reach-analysis-as-a-tinybird-run-snapshot-written-at-start.md)
- Kohavi and Longbotham, run at least one full weekly cycle; Waudby-Smith et al. (aCS miscoverage at
  small first peeking times).
