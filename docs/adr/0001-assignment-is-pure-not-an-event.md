# Assignment is a pure computation, not an event

**Status:** accepted

Assignment — the bucketing of an Entity into a Variant — is a pure deterministic function
`assign(Run, Targeting Key) -> Variant`, never recorded as an event. We recompute it on demand
(any runtime, offline, in backfills) rather than persisting it. The only event recorded on this seam
is **Exposure**, which carries the assigned Variant. This matches universal practice
(Statsig/Eppo/GrowthBook all recompute assignment; none log it as a primary fact) and means advanced
diagnostics like deterministic replay are available later without recording anything extra now.

Note: this deliberately *corrects* CONTEXT.md, which originally defined Assignment as "the event that
an Entity was bucketed." It is not an event.

## Consequences

- There is no "assigned but unexposed" record — an Entity bucketable but never exposed simply has no
  footprint. This is what makes the Run-boundary holdover logic (ADR-0006) fall out for free.
- Determinism is only meaningful relative to a frozen config, which is why Assignment is defined as
  pure *over a Run* (ADR-0002).
