/**
 * Tinybird-shaped inputs the local Analysis stub serves, one entry per seeded Run.
 *
 * Counts are deliberately distinct per Run so a Results read that served the
 * wrong Run's rows shows up as a wrong number rather than hiding behind a
 * matching shape.
 */
export const LOCAL_E2E_ANALYSIS_INPUTS = Object.freeze([
  analysisInput("env_checkout_dev_e2e", "experiment_checkout_dev_e2e", "run_checkout_dev_e2e", {
    control: 10,
    treatment: 10,
  }),
  analysisInput("env_checkout_prod_e2e", "experiment_checkout_prod_e2e", "run_checkout_prod_e2e", {
    control: 19,
    treatment: 1,
  }),
  // The dev Experiment's frozen earlier Run.
  analysisInput(
    "env_checkout_dev_e2e",
    "experiment_checkout_dev_e2e",
    "run_checkout_dev_previous_e2e",
    { control: 6, treatment: 6 },
  ),
  // #200 replaced this fixture's previously-obvious split (5/100 vs 80/100
  // conversions) with these "more realistic" counts, but 300/1500 vs
  // 315/1500 never actually clears the 95% significance bar under the real
  // Stats Engine (verified: is_significant: false, p=1) — it shipped anyway
  // because Control Panel E2E is skipped on pull requests. 370 clears the bar
  // (verified: is_significant: true, p ~= 0.0479) but sits on a knife edge
  // against the 0.05 threshold; 375 was chosen for a defensible margin
  // instead (verified: p ~= 0.026).
  analysisInput(
    "env_checkout_dev_e2e",
    "experiment_checkout_significance_e2e",
    "run_checkout_significance_e2e",
    { control: 1_500, treatment: 1_500 },
    { decisionMetric: "checkout-conversion", conversions: { control: 300, treatment: 375 } },
  ),
  analysisInput(
    "env_checkout_prod_e2e",
    "experiment_checkout_srm_e2e",
    "run_checkout_srm_e2e",
    { control: 140, treatment: 60 },
    { decisionMetric: "checkout-conversion", conversions: { control: 20, treatment: 12 } },
  ),
  // SPL-189: the same 7:3 imbalance as the SRM fixture above (scaled 1.5x so the
  // counts stay distinct per this module's invariant), reused on a Run whose
  // frozen control_variant_id is absent from its own variant_set (see the D1
  // seed). One Run firing both an unresolvable Control and a confirmed SRM is
  // exactly the case the two alert cards have to stay distinguishable on.
  analysisInput(
    "env_checkout_integrity_e2e",
    "experiment_checkout_integrity_e2e",
    "run_checkout_integrity_e2e",
    { control: 210, treatment: 90 },
    { decisionMetric: "checkout-conversion", conversions: { control: 30, treatment: 18 } },
  ),
  // Clean and decidable on every gate check, with a Guardrail Metric breached.
  // Guardrails deliberately do not gate, so this is the state where the ship
  // control sits next to a known regression.
  analysisInput(
    "env_checkout_dev_e2e",
    "experiment_checkout_guardrail_e2e",
    "run_checkout_guardrail_e2e",
    { control: 1_500, treatment: 1_500 },
    {
      decisionMetric: "checkout-conversion",
      conversions: { control: 300, treatment: 318 },
      guardrailMetric: "checkout-reliability",
      guardrailConversions: { control: 1_350, treatment: 900 },
    },
  ),
]);

function analysisInput(environmentId, experimentId, runId, counts, options = {}) {
  const decisionFamily = options.decisionMetric
    ? [{ metric_id: options.decisionMetric, variant: "treatment" }]
    : [];
  const guardrailDecisions = options.guardrailMetric
    ? [
        {
          metric_id: options.guardrailMetric,
          variant: "treatment",
          downside_threshold_pct: -10,
          guardrail_locked_at_run_start: true,
          threshold_locked_at_run_start: true,
        },
      ]
    : [];
  const metricSeries = [
    { metricId: options.decisionMetric, conversions: options.conversions },
    { metricId: options.guardrailMetric, conversions: options.guardrailConversions },
  ].filter((series) => series.metricId !== undefined && series.conversions !== undefined);
  return {
    appId: "app_checkout_e2e",
    environmentId,
    experimentId,
    runId,
    counts,
    decisionFamily,
    guardrailDecisions,
    // Binomial Metrics throughout, so every knob is the engine default and no
    // Metric needs an entry here.
    metricVarianceConfig: [],
    exposures: Object.entries(counts).flatMap(([variant, count]) =>
      Array.from({ length: count }, (_, index) => ({
        app_id: "app_checkout_e2e",
        targeting_key_hash: `${environmentId}-${variant}-${index}`,
        environment_id: environmentId,
        id_type: "user",
        run_id: runId,
        variant,
        first_exposure_ts: "2026-07-18T00:00:00.000Z",
        window_anchor: "2026-07-18T00:00:00.000Z",
        dimension_values: "{}",
      })),
    ),
    metricValues: metricSeries.flatMap((series) =>
      Object.entries(series.conversions).flatMap(([variant, count]) =>
        Array.from({ length: count }, (_, index) => ({
          targeting_key_hash: `${environmentId}-${variant}-${index}`,
          run_id: runId,
          metric_id: series.metricId,
          metric_type: "binomial",
          value: 1,
          in_window: 1,
        })),
      ),
    ),
  };
}
