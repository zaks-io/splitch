# Stats engine default: sequential always-valid, frequentist, asymptotic confidence sequences

**Status:** accepted

**Production target** — the default inference for a self-serve platform where users _will_ watch
dashboards continuously. The engine's default surface is:

1. **Sequential / always-valid inference, not fixed-horizon.** Continuous peeking with classical
   fixed-horizon tests inflates the real false-positive rate from the nominal 5% to **25–57%** (Optimizely's
   own A/A simulations; Kohavi's 5–10x). Always-valid inference keeps the error rate at target _no matter how
   often a user looks_. This is the highest-stakes default in the engine. The field is **genuinely split on
   the default**: Eppo defaults to sequential and Optimizely's Stats Engine is always-valid, but **Statsig and
   GrowthBook both default to fixed-horizon** and offer sequential as an opt-in. We diverge from that camp
   deliberately — a pre-registered fixed-horizon test with a locked sample size and no peeking is perfectly
   valid (and has the most power per sample), but our audience is self-serve users watching dashboards live,
   who _will_ peek, so the always-valid default is the one that protects them. Fixed-horizon remains an opt-in
   for a pre-committed sample size.
2. **Frequentist point of view with always-valid CIs.** Chosen over a Bayesian default (GrowthBook's bet)
   because a self-serve product cannot police priors — an informative prior lets a user "almost conjure any
   result" (Statsig). At scale a frequentist test and an uninformative-prior Bayesian one are near-identical,
   so the frequentist surface carries the least reasoning debt and no manipulation surface. (A Bayesian view
   may be offered later; it is not the default.)
3. **Asymptotic Confidence Sequences (aCS)** as the always-valid method, _not_ mSPRT. aCS **are**
   confidence intervals, just time-uniform, so they compose directly with the delta-method ratio CIs and
   CUPED of ADR-0015/0016 — one CI machinery made sequential. That compositionality is the real reason to
   pick aCS, _not_ a claim that it is parameter-free: aCS carries its own tuning knob (the time at which the
   sequence is tightest), just as mSPRT carries a mixing variance — neither is free. The honest contrast is
   that mSPRT is a separate likelihood-ratio object, so it composes less cleanly with the variance stack we
   already locked, whereas aCS _is_ a CI. (Terminology: aCS is Waudby-Smith et al.'s construction —
   GrowthBook's implementation — which is closely related to but not identical to Howard et al.'s GAVI; we
   mean the aCS specifically, not GAVI.)

## The peeking trap (why this is a default, not an option)

The trap is that fixed-horizon _looks_ fine — a user sees p < 0.05 and ships — while the act of having
watched repeatedly already inflated the error. It is invisible at the point of decision, exactly the
silent-corruption failure mode this architecture rejects elsewhere (`__multiple__` in ADR-0011, the
activated-population SRM in ADR-0012). Making always-valid the default makes the safe path the default path,
the same principle as exposure-on-read (ADR-0004).

## Considered options

- **Fixed-horizon default, sequential opt-in (the Statsig/GrowthBook posture)** — a legitimate, widely-held
  default, not a mistake: with a pre-committed sample and no peeking it is valid and maximally powerful. We
  reject it _for our audience_ — the moment a self-serve user peeks (they will), the real FPR is 20%+ and they
  don't know it. Right default for a disciplined analyst team; wrong default for self-serve.
- **Bayesian default (GrowthBook)** — rejected as the _default_ (not as a future option): defensible for
  stakeholder communication, but the prior is a self-serve footgun and the engine converges with frequentist
  at scale anyway.
- **mSPRT** — rejected: longer track record, but more bespoke surface against the CUPED + delta-method stack.

## Consequences

Always-valid CIs are **wider** than fixed-horizon CIs at the same N — less power per sample, the accepted
price of safe peeking. The engine exposes one CI object end to end: delta-method variance (ADR-0015) →
CUPED adjustment (ADR-0016) → always-valid sequence → relative-lift CI → Guardrail bound. Fixed-horizon is a
deliberate opt-in tied to a declared sample size, never the path of least resistance.

The confidence level / alpha is locked at Run Start for decision-valid results. Changing alpha after
observing results is an exploratory display edit, not a decision-valid significance edit for the current
Run. This lock is paired with ADR-0003's decision-spec lock and the BH family lock in the stats specs.

## Sources

- Johari, Koomen, Pekelis, and Walsh, always-valid inference:
  https://pubsonline.informs.org/doi/10.1287/opre.2021.2135
- Waudby-Smith and Ramdas, time-uniform confidence sequences for bounded means:
  https://academic.oup.com/jrsssb/article-abstract/86/1/1/7043257
