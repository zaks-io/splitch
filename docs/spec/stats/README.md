# Stats area spec index

The stats engine takes per-Entity Metric values from the Exposure pipeline and Activation gate
and produces trusted results: point estimates, always-valid CIs, significance calls, and health
diagnostics. The spine is one CI object flowing through six deterministic stages.

## Files

| File                                                                   | Purpose                                                                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [inference-engine.md](inference-engine.md)                             | The one CI object: variance → winsorization → CUPED → aCS → relative-lift → Guardrail → BH FDR; per-type estimators; failure contracts             |
| [multiple-comparisons-fdr.md](multiple-comparisons-fdr.md)             | Benjamini-Hochberg FDR over the goal-metric × Variant family; family definition and lock; BH algorithm; "None" mode; what's excluded               |
| [metric-types.md](metric-types.md)                                     | Metric taxonomy (Binomial / Count / Revenue / Ratio / Guardrail), per-Entity aggregation shapes, Conversion Window anchoring                       |
| [variance-reduction.md](variance-reduction.md)                         | CUPED gating and pre-period anchor; attribute-covariate fallback; winsorization defaults and application order                                     |
| [srm-and-health.md](srm-and-health.md)                                 | Full-exposed SRM + activated-population SRM; `__multiple__` quarantine; health metrics object                                                      |
| [sequential-testing-mechanics.md](sequential-testing-mechanics.md)     | aCS construction, boundary/tuning parameters, stopping rules; fixed-horizon opt-in; SequentialCI / FixedHorizonCI adapter interface                |
| [dimension-slicing.md](dimension-slicing.md)                           | Primary vs. secondary Dimensions; BH family expansion; composition with Activation gate                                                            |
| [data-contracts.md](data-contracts.md)                                 | Input rows from Exposure pipeline (deduped Exposure, per-Entity Metric values, pre-period covariates, activation rows); StatsEngine seam interface |
| [result-contracts.md](result-contracts.md)                             | Output shapes the engine writes: per-arm result, VarianceTechniques, SRM, Guardrail, and health objects                                            |
| [statistical-rigor-verification.md](statistical-rigor-verification.md) | Required unit, golden, property, simulation, and spec-lint gates for decision-valid stats                                                          |

## Spine idea

Every Metric flows through **one CI object** in a fixed order:

```
type-variance → delta-method → [winsorize] → [CUPED] → aCS → relative-lift → Guardrail → BH FDR
```

Each bracket step is gated: winsorization is skipped for Binomial; CUPED is skipped below
coverage threshold (with documented fallback). Nothing degrades silently.

## Key cross-area seams

- **Input from pipeline**: see [data-contracts.md](data-contracts.md) — the pipeline delivers per-Entity rows; raw event rows never enter the stats engine.
- **Input from Activation gate**: `window_anchor` and `activation_rows` arrive pre-computed; stats engine treats them as opaque facts.
- **Output to UI/API**: `StatsOutput` member shapes in [result-contracts.md](result-contracts.md); the UI/API layer owns rendering and does not re-implement any stat logic.
- **Tinybird isolation**: all stats reads proxy through an `app_id`-scoped control-plane endpoint; the Worker injects `app_id` from auth context.

## Out of scope for this area

- **Power / MDE calculator** (pre-experiment planning): consumes the same per-type variance model
  as the stats engine but is a pre-experiment tool, not a run-time analysis object. It is a
  thread handed forward from `metric-analysis-seam.md`. The variance estimators in
  [inference-engine.md](inference-engine.md) are the shared contract both sides read.
- **Bayesian results view** (chance-to-win, credible intervals): a future opt-in surface.
  Not the default; deferred unless a separate decision changes the inference contract.

## Locked defaults

- Confidence Level: **95% per-Experiment**, locked at Run Start for decision-valid results.
- CUPED pre-period: **always anchored at `first_exposure_ts`**, even under Activation gate.
- CUPED fallback: **automatic within the locked eligible covariate set**, ranked by pre-period or historical variance-reduction; chosen method reported in output.
- Winsorization: **99.9th percentile, default-on** for Count/Revenue; pooled cap, never per-arm, never for Binomial.
- BH FDR family: **goal-metric × Variant, locked at Run Start**; Primary Dimensions included only if declared before Start; Guardrails and secondary Dimensions excluded.
- Ratio Metric covariance: **per-Entity `(num_value, denom_value)` pair** delivered by pipeline — non-negotiable, unrecoverable after aggregation.
- Statistical rigor gates: decision-valid stats require the verification ladder in [statistical-rigor-verification.md](statistical-rigor-verification.md).
