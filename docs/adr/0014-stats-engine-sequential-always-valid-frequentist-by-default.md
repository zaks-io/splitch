# Stats engine default: sequential always-valid, frequentist, asymptotic confidence sequences

**Status:** accepted

**Production target** — the default inference for a self-serve platform where users *will* watch
dashboards continuously. The engine's default surface is:

1. **Sequential / always-valid inference, not fixed-horizon.** Continuous peeking with classical
   fixed-horizon tests inflates the real false-positive rate from the nominal 5% to **25–57%** (Optimizely's
   own A/A simulations; Kohavi's 5–10x). Always-valid inference keeps the error rate at target *no matter how
   often a user looks*. This is the highest-stakes default in the engine and the one place the literature is
   unanimous about the fix. Fixed-horizon remains available as an opt-in for a pre-committed sample size.
2. **Frequentist point of view with always-valid CIs.** Chosen over a Bayesian default (GrowthBook's bet)
   because a self-serve product cannot police priors — an informative prior lets a user "almost conjure any
   result" (Statsig). At scale a frequentist test and an uninformative-prior Bayesian one are near-identical,
   so the frequentist surface carries the least reasoning debt and no manipulation surface. (A Bayesian view
   may be offered later; it is not the default.)
3. **Asymptotic Confidence Sequences (aCS / GAVI)** as the always-valid method, *not* mSPRT. aCS **are**
   confidence intervals, just time-uniform, so they compose directly with the delta-method ratio CIs and
   CUPED of ADR-0015/0016 — one CI machinery made sequential. mSPRT is a separate likelihood-ratio object
   needing a mixing-variance parameter and composes less cleanly with the variance stack we already locked.

## The peeking trap (why this is a default, not an option)

The trap is that fixed-horizon *looks* fine — a user sees p < 0.05 and ships — while the act of having
watched repeatedly already inflated the error. It is invisible at the point of decision, exactly the
silent-corruption failure mode this architecture rejects elsewhere (`__multiple__` in ADR-0011, the
activated-population SRM in ADR-0012). Making always-valid the default makes the safe path the default path,
the same principle as exposure-on-read (ADR-0004).

## Considered options

- **Fixed-horizon default, sequential opt-in (Statsig posture)** — rejected: the moment a self-serve user
  peeks (they will), the real FPR is 20%+ and they don't know it. Wrong default for this audience.
- **Bayesian default (GrowthBook)** — rejected as the *default* (not as a future option): defensible for
  stakeholder communication, but the prior is a self-serve footgun and the engine converges with frequentist
  at scale anyway.
- **mSPRT** — rejected: longer track record, but more bespoke surface against the CUPED + delta-method stack.

## Consequences

Always-valid CIs are **wider** than fixed-horizon CIs at the same N — less power per sample, the accepted
price of safe peeking. The engine exposes one CI object end to end: delta-method variance (ADR-0015) →
CUPED adjustment (ADR-0016) → always-valid sequence → relative-lift CI → Guardrail bound. Fixed-horizon is a
deliberate opt-in tied to a declared sample size, never the path of least resistance.
