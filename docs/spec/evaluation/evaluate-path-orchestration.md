# Evaluate path orchestration

The evaluate path is the hot-path orchestrator that consults two sibling seams (Provider
and Assignment Store) to produce a Variant for each flag, with zero superposition: every
branch is visible, every ADR maps to one pointable line.

## Pseudocode (canonical)

```
function evaluate(appId, environmentId, experimentId, flagKey, evalContext):
  // evalContext: { targetingKey, idType, ...attributes }
  // environmentId is resolved from the SDK key before the evaluate path runs (ADR-0027).

  // 1. Eager pre-load: one edge-local KV read, all Experiments for this Entity.
  held = AssignmentStore.getAll(appId, evalContext.idType, evalContext.targetingKey)
  //    held: Map<experimentId, { runId, variant }>

  // 2. Provider resolves live flag config (stateless, cached, includes liveRun hydrated).
  flagConfig = Provider.getFlag(appId, environmentId, flagKey)
  experiment = Provider.getExperiment(appId, environmentId, experimentId)

  // 3. Flag disabled → Default Variant, no Exposure.
  if not flagConfig.enabled:
    return { variant: flagConfig.defaultVariant, reason: { type: 'default_disabled' } }

  // 4. Holdover check: has this Entity been exposed under any prior Run of this Experiment?
  if held.has(experimentId):                          // ADR-0006: sticky experience
    holdover = held.get(experimentId)
    return { variant: holdover.variant, isHoldover: true, priorRunId: holdover.runId }
    // No new Exposure fired. No Assignment Store write.

  // 5. No holdover → new or never-exposed Entity. Must be a live Run.
  liveRun = experiment.liveRun
  if liveRun is null:
    return { variant: flagConfig.defaultVariant, reason: { type: 'default_disabled' } }

  // 6. Targeting: iterate rules in priority order, first match wins.
  for rule in sorted(liveRun.targetingRules, by: priority ascending):
    if matchesConditions(rule.conditions, evalContext):
      if rule.percentageRollout is not null:
        variant = fractionalEval(liveRun.salt, evalContext.targetingKey, rule.percentageRollout)
        selection = 'percentage_rollout'
      else:
        variant = rule.variant
        selection = 'direct'
      return { variant, reason: { type: 'rule_matched', ruleId: rule.ruleId, ruleName: rule.ruleName, priority: rule.priority, selection }, liveRunId: liveRun.runId }

  // 7. No rule matched → Default Variant.
  return { variant: flagConfig.defaultVariant, reason: { type: 'no_match_default' }, liveRunId: liveRun.runId }
```

## Return shape

```
EvaluateResult {
  variant: string                // Variant name (always present)
  reason?: ReasonDetail          // present for non-holdover paths
  isHoldover?: true              // set when replay path taken
  priorRunId?: string            // set on holdover path; which Run owns this Entity's Exposures
  liveRunId?: string             // set on non-holdover paths where a live Run exists
}
```

The `reason` field uses the discriminated union defined in
[test-evaluation-endpoint.md](./test-evaluation-endpoint.md). The evaluate path computes
it on every non-holdover path, so test-evaluation shares the same logic without
re-implementation.

`isHoldover` and `priorRunId` are present on the replay path so callers (SDK, Exposure
pipeline) can distinguish replay from fresh assignment without inspecting the Variant name.
This eliminates the superposition identified in the seam findings.

## Role boundaries

**Provider** (stateless): resolves `FlagConfig` and `ExperimentConfig` (with `liveRun`
hydrated). Returns the full rule set. Does not iterate rules, does not match conditions.

**Assignment Store** (dumb storage): `getAll()` returns the pre-loaded holdover map.
Returns facts only; never branches, never calls `assign()`.

**evaluate path** (policy): owns rule iteration (first-match), condition matching,
Fractional Evaluation, holdover predicate, replay decision. One code location for all
policy.

**Exposure pipeline** (downstream): fires Exposure events on read via `read-variant()`
accessor; calls `AssignmentStore.put()` at first-touch. The evaluate path does not write
to the Assignment Store.

## Condition matching

```
matchesConditions(conditions: Condition[], context: EvaluationContext) -> boolean
```

All Conditions must match (AND semantics). For `segment_in` / `segment_not_in` operators,
membership = Entity matches the Segment's own Conditions (recursively evaluated;
Segments are Conditions, not a separate authorization layer).

Missing context attribute: treated as null; operators that require the attribute to be
present (`eq`, `gt`, etc.) return false. Operators on null: fail-loud (log a warning; do
not silently pass).

## Fractional Evaluation

```
fractionalEval(salt: string, targetingKey: string, rollout: PercentageRollout) -> string
```

Hash input: `salt + ":" + targetingKey`. Output: deterministic bucket assignment across
`rollout.weights`. The Targeting Key is always the hash input — no runtime polymorphism
on the hashing identity.

## Cross-runtime invariant

`evaluate()` runs on Workers, Durable Objects, and lambdas (five runtimes). It must
produce identical output on all. This requires:
- `assign()` is pure (no runtime-specific entropy).
- `AssignmentStore.getAll()` is edge-local (~10ms KV read; no DO hop on evaluate).
- `Provider.getFlag/getExperiment()` are cache reads (no upstream network hop on hot path).

## Seam boundary

**What's on this side (evaluate path):** rule matching, holdover predicate, replay decision,
Fractional Evaluation, EvaluateResult shape.

**What's NOT here:** Exposure log writes (pipeline), Assignment Store writes (pipeline),
rule-config storage (Provider), holdover storage (Assignment Store).

**No superposition:** every branch in the pseudocode maps to a distinct observable output.
`isHoldover` vs fresh assignment vs no-live-run vs disabled are all structurally different
return shapes. No caller needs to guess which path was taken.

## Sources

- [../../adr/0001-assignment-is-pure-not-an-event.md](../../adr/0001-assignment-is-pure-not-an-event.md)
- [../../adr/0004-exposure-fires-on-read.md](../../adr/0004-exposure-fires-on-read.md)
- [../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md](../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md)
- [../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md](../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md)
- [../../architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md) (evaluate path section)
- [../../architecture/assignment-exposure-seam.md](../../architecture/assignment-exposure-seam.md) (spine)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
