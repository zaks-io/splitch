# Material edits — including measurement changes — open a new Run

**Status:** accepted

An edit is **material** (ends the current Run, opens the next) if it changes `assign()` *or* what the
numbers mean. Critically, this includes **measurement** edits — Metric definitions, Conversion Window,
Guardrail/Activation config — not just assignment-affecting edits. So a Run guarantees that **both
bucketing and measurement were frozen** for its life, a stronger invariant than the reference platforms
enforce (GrowthBook Phases window only dates). Non-material edits (description, owner, tags, dashboard
layout) apply in place.

## Considered options

- **Run = frozen assignment only**, measurement editable in place — rejected: a Metric or window edit
  makes pre/post numbers non-comparable, so a Run would no longer be a self-consistent dataset.
- **Split**: assignment edits open a Run, measurement edits versioned within it — rejected as more
  machinery than the integrity gain justifies for v1; the strict rule is simpler to reason about.

## Consequences

A measurement tweak mid-experiment costs you the accumulated sample (a new Run starts from zero
Exposures). This is correct but expensive, and enforces the intended discipline: **design the
experiment fully before starting it.** The UI must warn loudly before any material edit.
