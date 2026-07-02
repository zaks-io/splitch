# The Assignment Store is dumb storage; replay policy lives on the evaluate path

**Status:** accepted

The Assignment Store interface promises exactly two operations and **zero policy**:

```
getAll(app_id, environment_id, idType, targetingKey) -> Map<experiment, {runId, variant}>   # eager pre-load
put(app_id, environment_id, experiment, idType, targetingKey, runId, variant)               # first-touch write
```

`app_id` and `environment_id` co-scope every call (Experiments and their Runs are per-Environment,
ADR-0027); `getAll` returns one Environment's holdovers across all its Experiments in a single
edge-local read. They do **not** enter the per-record storage key — an Experiment belongs to exactly one
Environment, so `experiment_id` already implies the Environment. (Canonical signature:
`docs/spec/domain-model/assignment-store.md`.)

It is durable memory and nothing else. The **evaluate path** owns all policy — the holdover predicate, the
replay-vs-`assign()` choice, first-touch write timing, runId stamping. The store never branches, never calls
`assign()`, never decides anything.

This rejects a "deeper" `resolveAssignment(exp, run, key) -> variant` that would consult holdover, fall
through to `assign()`, and maybe stamp — all internally. That interface is _shallower than it looks_: it is
more complex than what it hides, because a caller cannot tell from the call site which of three states
occurred (replayed / freshly assigned / stamped). It is a superposition you have to read the implementation
to collapse. Dumb get/put keeps the evaluate path a readable straight line where every branch is visible:

```
validatedIdType = assertMatchesExperiment(idType, experiment.targetingKeyType)
held = AssignmentStore.getAll(experiment, validatedIdType, targetingKey)   # one edge-local read
for flag in flags:
    if held[exp] present:            # holdover: returning, already exposed
        variant = held[exp].variant  #   replay (ADR-0006); no write, no new Exposure
    else:                            # new / never-exposed Entity
        variant = assign(liveRun, targetingKey)   # pure hash (ADR-0001)
        # Exposure fires on read (ADR-0004); pipeline writes holdover at first-touch (ADR-0005)
```

Every ADR maps to one pointable line. `assign()` stays pure. Statsig and GrowthBook both land here:
storage is dumb, the engine owns the replay decision.

## Considered options

- **`resolveAssignment` (storage + `assign()` fused)** — rejected: hides the replay-vs-assign branch behind
  one method, producing the three-state superposition above. Fewer call-site lines, but you trade them for
  unreadability and a store that can no longer be reasoned about in isolation.

## Consequences

The evaluate path carries orchestration logic instead of delegating it. That is the point: it concentrates
the policy in one legible place rather than smearing it into the storage adapter, and lets the store be
tested as pure get/put. The interface details — key is `(Experiment, idType, Targeting Key)` (idType guards
cross-Entity-type key collisions, per Statsig's `userID:idType`); value is `(runId, Variant)` (Variant =
what to replay, runId = which Run owns the Exposures, ADR-0006) — are fixed in
[the design doc](../architecture/assignment-store-seam.md).
