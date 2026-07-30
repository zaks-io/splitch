# The Run is the immutable unit of analysis

**Status:** accepted

A **Run** is a time-boxed window of an Experiment whose **assignment config** (salt, allocation, Variant
set, Control identity, Targeting, Targeting Key) is frozen for its entire life. D1 stores the Control as
the immutable `runs.control_variant_id`, copied from `experiments.default_variant_id` at Start. Every
Exposure is stamped with its `runId`, and SRM, significance, and Conversion Windows are all scoped to a Run. We chose this over a bare
`configVersion` counter because the Run carries a real invariant — "this dataset is analyzable as a unit" —
that an opaque version number does not. Because the Run is immutable, Assignment (ADR-0001) is pure over it
and re-bucketing within a Run is impossible by construction.

Runs created before `control_variant_id` existed are backfilled from the Experiment's current
`default_variant_id` at migration time. That value is explicitly the best-available legacy identity,
not a claim that the original historical Control can be reconstructed. Runs started after the
migration always freeze the Control at Start.

The invariant is **frozen bucketing and its analysis identity**, not frozen measurement. Metric definitions, the Conversion Window,
and Guardrail/Activation config are _not_ part of the Run's frozen config — they recompute losslessly over
the Run's raw log (ADR-0003). Analyzability requires only that _who is in which arm_ was fixed; _what we
measure over them_ is reproducible at query time.

## Considered options

- **`configVersion` counter** — rejected: answers "did this change?" but not "is this comparable?"
  Analysis would have to reconstruct comparability at query time.
- **GrowthBook Phase / Statsig version** — the closest prior art and the model we follow: a Phase/version
  windows the _assignment_ config and lets measurement recompute over the collected data (ADR-0003).

## Consequences

Runs are **independent**: the latest Run is the live result, prior Runs are frozen archives, and they
are **never pooled** by default. An **assignment edit** therefore resets the accumulated sample — the UI must
surface this loudly. (A measurement edit does not; it recomputes — ADR-0003.) Pooling, if ever needed, is a future explicit, guarded feature, not the default;
offering it casually would reintroduce the cross-config contamination the Run exists to prevent.
