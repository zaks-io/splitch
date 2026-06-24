# Run boundary: sticky experience, counted in the old Run

**Status:** accepted

At a Run boundary, an Entity already **exposed** under a prior Run (a **holdover**) keeps showing its
prior Variant — sticky _experience_, to avoid a jarring mid-experiment flip — but its Exposures stay
attached to the Run it was first exposed under and are **not re-counted** in the new live Run. New (and
never-exposed) Entities flow into the new Run cleanly. This separates _assignment-for-experience_ from
_assignment-for-analysis_, preserving both Run-dataset purity (ADR-0002) and a non-jarring UX, which the
naive "stick and pool into the new Run" option would not.

The **sticky-experience** half is standard practice (Statsig Persistent Assignment, GrowthBook Sticky
Bucketing both preserve a returning Entity's bucket). The **experience-vs-analysis split** — keeping the
holdover's Exposures attributed to the _old_ Run rather than accruing into the new one — is splitch's own
addition, not something those vendors document; it falls out of treating the Run as the immutable unit of
analysis (ADR-0002). We own it as a deliberate divergence, not as inherited prior art.

The holdover predicate is "has a first-touch Exposure under a prior Run" — which works precisely because
Assignment leaves no trace (ADR-0001), so there is no assigned-but-unexposed ambiguity.

## Considered options

- **Hard re-bucket at the boundary** — simplest, cleanest data, but flips returning users' experience
  (carryover-bias risk). Acceptable for short experiments; rejected as the default.
- **Sticky AND pooled into the new Run** — maximum continuity but contaminates the new Run with
  old-config bucketing, violating the Run invariant. Rejected.

## Consequences

Sticky experience requires persisting the holdover's original Variant — `assign()` cannot recompute it
once the old config is gone. This is the **single piece of durable per-Entity state** on the seam:
`(Experiment, Targeting Key) -> (runId, Variant)`, written at first Exposure. The key does not carry
`environment_id`: an Experiment belongs to exactly one Environment (ADR-0027), so `experiment_id`
already pins the Environment and the holdover is per-Environment by construction. The _storage_ is the same kind
of port as Statsig Persistent Assignment / GrowthBook Sticky Bucketing (a per-Entity bucket record); the
stored `runId` and the old-Run attribution it enables are splitch's addition on top. It needs a low-latency,
edge-local read on the evaluate path — a hard constraint on the Provider/storage seam, to be designed there.
