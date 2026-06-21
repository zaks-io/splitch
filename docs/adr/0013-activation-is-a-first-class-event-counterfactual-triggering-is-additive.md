# Activation is a first-class logged event; counterfactual triggering is an additive extension, not a rewrite

**Status:** accepted

This ADR pins the production-ready schema foundation, not a half-built prototype to be thrown away. The
guarantee this ADR makes is **no rewrite** — the hardest
correctness feature of the gate (counterfactual triggering) can be added later without changing the event
log, the gate query, the Conversion Window anchor, or the SRM. If adding it later required a migration,
that would be a failure; this ADR is what prevents it.

## The decision

**Activation is a first-class logged event** — its own row type on the same append-only Exposure log
(ADR-0010), carrying `(Entity, Run, activation_ts)` — _not_ a flag derived inside a query. This is the load-
bearing schema choice. Everything downstream (the gate filter, the `activation_ts` re-anchor, the
activated-population SRM, the activation-rate Metric — all ADR-0012) reads activation events generically.

Because of that, **counterfactual triggering becomes additive**: the future Kohavi-correct gate (include
Treatment Entities that activated AND Control Entities that _would have_ activated) is implemented as the
Control arm emitting an activation-shaped event with a `counterfactual: true` marker. That is a new column
_value_, flowing through the **same** log, the **same** join, the **same** anchor, and the **same** SRM —
zero schema change, zero query rewrite.

## Decision boundary

- **Pinned here:** activation as a first-class event; the gate query; the
  `activation_ts` re-anchor; both bias guardrails (ADR-0012). Correct for variant-independent activations,
  loud for the rest.
- **Deferred (additive later):** the SDK-side Control-arm _would-have-activated evaluation logic_ — the one
  piece that genuinely cannot be built or tested today, because no SDK, pipeline, or experiment exists yet.
  Building it now would be untestable code, not added production-readiness; the schema is already ready for
  it.

## Considered options

- **Build the SDK counterfactual evaluation here too** — rejected: no SDK/pipeline/experiment exists to
  build or test it against, so it is speculative, untestable machinery. The schema (this ADR) is what makes
  the design production-ready and rewrite-proof; the blind logic is not.
- **Derive activation as a query-only flag (no first-class event)** — rejected: this is the actual rewrite
  trap. Adding counterfactual triggering later would then force a new event type, a new join shape, and a
  changed SRM population — exactly the migration this ADR exists to avoid.

## Consequences

The activated-population SRM (ADR-0012) is the signal that tells you _when_ a real experiment needs
counterfactual triggering: a gated-scorecard SRM with no full-exposed SRM means the gate is Treatment-
affected, and that experiment is the one that justifies building the deferred logic. Until then, the gate evaluates
correctly and fails loudly — on the schema the extension drops into untouched.
