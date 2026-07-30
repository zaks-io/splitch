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
  analysisInput(
    "env_checkout_dev_e2e",
    "experiment_checkout_significance_e2e",
    "run_checkout_significance_e2e",
    { control: 100, treatment: 100 },
    { decisionMetric: "checkout-conversion", conversions: { control: 5, treatment: 80 } },
  ),
  analysisInput(
    "env_checkout_prod_e2e",
    "experiment_checkout_srm_e2e",
    "run_checkout_srm_e2e",
    { control: 140, treatment: 60 },
    { decisionMetric: "checkout-conversion", conversions: { control: 20, treatment: 12 } },
  ),
  analysisInput(
    "env_checkout_dev_e2e",
    "experiment_checkout_guardrail_e2e",
    "run_checkout_guardrail_e2e",
    { control: 100, treatment: 100 },
    {
      guardrailMetric: "checkout-reliability",
      conversions: { control: 80, treatment: 10 },
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
          downside_threshold: -10,
          guardrail_locked_at_run_start: true,
          threshold_locked_at_run_start: true,
        },
      ]
    : [];
  const metricId = options.decisionMetric ?? options.guardrailMetric;
  return {
    appId: "app_checkout_e2e",
    environmentId,
    experimentId,
    runId,
    counts,
    decisionFamily,
    guardrailDecisions,
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
    metricValues: metricId
      ? Object.entries(options.conversions ?? {}).flatMap(([variant, count]) =>
          Array.from({ length: count }, (_, index) => ({
            targeting_key_hash: `${environmentId}-${variant}-${index}`,
            run_id: runId,
            metric_id: metricId,
            metric_type: "binomial",
            value: 1,
            in_window: 1,
          })),
        )
      : [],
  };
}
