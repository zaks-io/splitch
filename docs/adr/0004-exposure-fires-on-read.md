# Exposure fires on read (safe default), deferral is an explicit accessor

**Status:** accepted

Reading a Variant through the SDK accessor fires the Exposure event as a side effect — you cannot
branch on the Variant without having been exposed. This makes the safe path the default and structurally
eliminates the #1 real-world experimentation bug: evaluate, branch on the Variant, then forget to fire
exposure, producing silent (and often Variant-differential) under-exposure. Deferral (e.g. below-the-fold
UI) is a distinct, loudly-named "peek without exposing" accessor.

## Considered options

- **Explicit separate `exposure()` call** — rejected: honest about deferral but leaves the
  forget-to-fire footgun wide open.
- **Auto-expose at Evaluation with an opt-out flag to defer** — viable, but couples exposure to
  evaluation rather than to consumption; reading-binds-exposure is the more precise default.

## Consequences

The accessor has a side effect, which is surprising and **must be documented prominently**. It also
makes raw Exposures many-per-Entity, which forces the dedup rule in ADR-0005.
