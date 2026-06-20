# The Run is the immutable unit of analysis

**Status:** accepted

A **Run** is a time-boxed window of an Experiment whose config (salt, allocation, Variant set,
Targeting) is frozen for its entire life. Every Exposure is stamped with its `runId`, and SRM,
significance, and Conversion Windows are all scoped to a Run. We chose this over a bare `configVersion`
counter because the Run carries a real invariant — "this dataset is analyzable as a unit" — that an
opaque version number does not. Because the Run is immutable, Assignment (ADR-0001) is pure over it and
re-bucketing within a Run is impossible by construction.

## Considered options

- **`configVersion` counter** — rejected: answers "did this change?" but not "is this comparable?"
  Analysis would have to reconstruct comparability at query time.
- **GrowthBook Phase / Statsig version** — these are the closest prior art and informed the design, but
  both window only *dates*; our Run freezes measurement too (ADR-0003).

## Consequences

Runs are **independent**: the latest Run is the live result, prior Runs are frozen archives, and they
are **never pooled** by default. A material edit therefore resets the accumulated sample — the UI must
surface this loudly. Pooling, if ever needed, is a future explicit, guarded feature, not the default;
offering it casually would reintroduce the cross-config contamination the Run exists to prevent.
