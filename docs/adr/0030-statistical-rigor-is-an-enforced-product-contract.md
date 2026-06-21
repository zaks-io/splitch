# Statistical rigor is an enforced product contract

**Status:** accepted

splitch is not just a flag router with charts. When it reports significance, a Guardrail breach, or a
healthy Experiment Run, customers will treat that as decision support. Bad statistics are product bugs,
not analyst preference. This ADR makes statistical rigor an enforceable contract across ingest,
analysis, UI/API output, and review.

## Decision

Every statistics-facing implementation must preserve five guarantees:

1. **Capture is auditable.** Raw Exposure and Activation events carry retry-stable event ids,
   source identity, ingest watermarks, and deterministic dedup keys. The raw log remains the
   system of record; analysis can be replayed.
2. **Decision validity is pre-committed.** At Run Start, the decision spec is snapshotted:
   confidence level / alpha, horizon and tuning, goal Metric family, Guardrail thresholds,
   Primary Dimensions, winsorization config, and CUPED-eligible covariates. Results outside
   that snapshot are exploratory unless a new Run or future locked-analysis version is started.
3. **Variance is computed at the Entity level.** No event-as-independent, session-as-denominator,
   or naive ratio variance path exists. Ratio Metrics and relative lift use delta-method variance.
4. **Sequential inference is real, not decorative.** Always-valid p-values and intervals must remain
   valid under repeated looks. Fixed-horizon analysis is allowed only when the sample size is locked
   and peeking is not used for decision-valid calls.
5. **Outputs are self-auditing.** Every result carries enough metadata to explain whether it is
   decision-valid: Run id, decision spec version/hash, `decision_valid`, `exploratory`,
   `in_bh_family`, applied variance techniques, health diagnostics, and data watermark.

## Enforcement model

The contract is enforced in four layers:

1. **Schema and mutation validation.**
   - Zod request schemas require ingest identity fields before events reach Tinybird.
   - Run Start persists the decision spec snapshot.
   - Mutations that would alter decision-valid alpha, horizon/tuning, goal Metric family, Guardrail
     thresholds, or Primary Dimensions on a running Run return `DECISION_LOCKED`.

2. **Single implementation seams.**
   - One shared dedup key constructor.
   - One first-touch dedup query definition.
   - One stats engine CI pipeline: type variance -> winsorization -> CUPED -> aCS / fixed horizon
     -> relative lift -> Guardrail -> BH FDR.
   - UI/API code renders result metadata and never recomputes statistical logic.

3. **Regression gates.**
   - Deterministic unit and golden tests cover every statistical invariant.
   - Seeded simulation tests check false-positive control, BH FDR behavior, SRM detection, activation
     balance detection, and sequential peeking safety.
   - Spec lint blocks known drift phrases and formulas that represent past blind spots.

4. **Review policy.**
   Any change touching ingest, dedup, Run Start, Metric aggregation, CI construction, FDR, Guardrails,
   Activation gates, or result rendering must cite the governing ADR/spec and either add/update a
   regression fixture or explain why no fixture is needed.

## Required test families

The concrete test plan lives in
[../spec/stats/statistical-rigor-verification.md](../spec/stats/statistical-rigor-verification.md).
At minimum, implementation must include:

- Contract tests for ingest fields, dedup key stability, and watermark semantics.
- Decision-lock tests for post-start alpha, horizon, family, Guardrail, and Primary Dimension edits.
- Golden tests for Binomial, Count, Revenue, Ratio, relative lift, Guardrail, CUPED, winsorization,
  BH FDR, SRM, and Activation balance.
- Metamorphic tests that prove row order, duplicate raw events, and non-authoritative SDK seen-set
  behavior do not change decision-valid results.
- Monte Carlo tests for null false-positive rate, repeated peeking, FDR control, and SRM detection.
- Spec-lint tests for banned lifecycle/statistical drift.

## Consequences

This adds up-front work. Some tests will be slow and should run in a nightly or full CI gate rather
than every local edit. That cost is intentional. The alternative is a system that looks precise while
silently overstating certainty.

The implementation may ship in stages, but decision-valid stats may not ship without the matching
regression gates for the invariants they depend on. Exploratory or prototype stats must be labeled as
such in the API and UI.

## Sources

- Johari, Koomen, Pekelis, and Walsh, always-valid inference:
  https://pubsonline.informs.org/doi/10.1287/opre.2021.2135
- Waudby-Smith and Ramdas, time-uniform confidence sequences:
  https://academic.oup.com/jrsssb/article-abstract/86/1/1/7043257
- Deng, Knoblich, and Lu, Applying the Delta Method in Metric Analytics:
  https://arxiv.org/abs/1803.06336
- Deng, Xu, Kohavi, and Walker, CUPED:
  https://robotics.stanford.edu/~ronnyk/2013-02CUPEDImprovingSensitivityOfControlledExperiments.pdf
- Benjamini and Hochberg, controlling the false discovery rate:
  https://rss.onlinelibrary.wiley.com/doi/10.1111/j.2517-6161.1995.tb02031.x
- Fabijan et al., Diagnosing Sample Ratio Mismatch in Online Controlled Experiments:
  https://dl.acm.org/doi/10.1145/3292500.3330722
