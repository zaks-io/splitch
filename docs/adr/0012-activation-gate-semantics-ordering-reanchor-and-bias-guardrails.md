# Activation gate semantics: activation follows exposure, re-anchors the window, ships bias guardrails

**Status:** accepted

**Production target.** This is a production decision on the final data model, not a bootstrap stopgap.
The v1 gate is fully functional and correct for variant-independent activations (the common case) and
loud for the rest; nothing here is intended to be rewritten.

An Activation Metric gates analysis to **activated** Entities. Three semantics are locked:

1. **Activation must follow Exposure** — `activation_ts > first_exposure_ts` per `(Entity, Run)`. A
   pre-exposure activation never counts. Statsig states this verbatim ("must occur after the exposure");
   the deeper reason is the Kohavi/Microsoft OCE literature — filtering on pre-exposure data breaks
   randomization (post-treatment selection bias).
2. **The Conversion Window re-anchors to `activation_ts`** when the gate is set (Eppo's automatic
   behavior; Statsig offers it as a toggle). Activation is the true entry moment, so the measurement clock
   starts there, not at `first_exposure_ts`. The anchor is therefore
   `COALESCE(activation_ts, first_exposure_ts)` — a clean branch, not a superposition. (GrowthBook keeps
   the window at first exposure; we chose the causal-cleaner re-anchor, knowing the field is split.)
3. **Two bias guardrails ship with the gate** (see below).

## The bias trap and the guardrails

If the Treatment changes whether an Entity activates, conditioning on activation biases every downstream
Metric — and, per GrowthBook's explicit warning, this "can cause bias that is not picked up by SRM
errors": the full-population assignment SRM can read a clean 50/50 while the *activated* subpopulation is
skewed. This is the same silent-corruption-behind-a-green-dashboard failure ADR-0011 rejects. No reference
vendor reports activation rate as a per-arm balance metric, so splitch goes further than all three:

- **Activated-population SRM** — chi-square on the activated Entities per arm per Run (p < 0.001),
  *separate* from the full-exposed SRM. An SRM that appears only in the gated scorecard is the canonical
  fingerprint of a Treatment-affected gate (Microsoft OCE diagnosis).
- **Per-arm activation rate as a first-class Metric** — divergence across arms is a loud alert and explains
  *why* the gated SRM fired.

Either guardrail firing means the gated results are **untrusted**. v1 also prefers/assumes
activation conditions determinable independent of variant; the guardrails catch violations loudly.

## Considered options

- **First-exposure anchor under gating (GrowthBook)** — rejected: measures from before the Entity entered
  the experience; the activation re-anchor is the cleaner causal story.
- **Generic post-assignment-bias warning only (vendor-minimum)** — rejected: the literature calls a
  doc-warning insufficient, and it violates splitch's fail-loud principle (ADR-0011).

## Consequences

The gate is a **query-time filter composing with the first-touch dedup** (ADR-0010/0005), not a separate
pipeline: dedup to first Exposure, join activation events with `activation_ts > first_exposure_ts`, anchor
the window on `activation_ts`, exclude un-activated Entities, and compute the activated-population SRM. The
`__multiple__` quarantine (ADR-0011) still applies upstream. Counterfactual triggering (Kohavi's full
unbiased gate) is deferred but made additive by ADR-0013, not by hand-waving.
