import type { DedupeExposureRow, PerEntityMetricRow } from "@splitch/contracts";
import { estimateMetricComparison } from "./variance-estimators";
import type { CupedCovariateRow, MetricComparisonEstimate } from "./variance-estimator-types";

const RUN_ID = "run_cuped_type_i";
const TS = "2026-07-01T00:00:00.000Z";
const PRE_TS = "2026-06-01T00:00:00.000Z";
const SEED = 12345;
const TRIALS = 3000;
const ENTITIES_PER_ARM = 400;
const Z_CRITICAL = 1.959963984540054;
const BASE_RATE = 0.3;

export const ALPHA = 0.05;

/** Both signs, because the inflation from a broken fit scales with rho. */
export const CORRELATIONS = [-0.9, -0.5, 0.5, 0.9] as const;

/** 3 Monte Carlo standard errors at 3000 trials is about 0.0075. */
export const TOLERANCE = 3 * Math.sqrt((ALPHA * (1 - ALPHA)) / TRIALS);

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rejectionRate(trial: (rand: () => number) => MetricComparisonEstimate): number {
  const rand = mulberry32(SEED);
  let rejections = 0;

  for (let index = 0; index < TRIALS; index += 1) {
    const result = trial(rand);
    const lift = result.absolute_lift;
    const samplingVar = result.absolute_lift_sampling_var;
    if (lift === null || samplingVar === null || samplingVar <= 0) {
      throw new Error("A/A trial produced no usable absolute lift.");
    }
    if (Math.abs(lift) / Math.sqrt(samplingVar) > Z_CRITICAL) {
      rejections += 1;
    }
  }

  return rejections / TRIALS;
}

/** One A/A trial: a pre-period covariate correlated with the Metric, no effect. */
export function countAaTrial(
  rand: () => number,
  options: { useCuped: boolean; correlation: number },
): MetricComparisonEstimate {
  return aaTrial("count", options.useCuped, () => {
    const covariate = standardNormal(rand);
    const noise = Math.sqrt(1 - options.correlation ** 2) * standardNormal(rand);
    return { covariate, value: options.correlation * covariate + noise };
  });
}

/**
 * The Binomial analogue: a pre-period conversion that the in-experiment
 * conversion copies with probability `agreement`, and otherwise redraws.
 */
export function binomialAaTrial(
  rand: () => number,
  options: { useCuped: boolean; agreement: number },
): MetricComparisonEstimate {
  return aaTrial("binomial", options.useCuped, () => {
    const covariate = rand() < BASE_RATE ? 1 : 0;
    const copied = rand() < options.agreement;
    return { covariate, value: copied ? covariate : rand() < BASE_RATE ? 1 : 0 };
  });
}

function aaTrial(
  metricType: "count" | "binomial",
  useCuped: boolean,
  draw: () => { covariate: number; value: number },
): MetricComparisonEstimate {
  const exposures: DedupeExposureRow[] = [];
  const metricValues: PerEntityMetricRow[] = [];
  const covariates: CupedCovariateRow[] = [];

  for (const variant of ["control", "treatment"]) {
    for (let index = 0; index < ENTITIES_PER_ARM; index += 1) {
      const targetingKeyHash = `${variant}_${index}`;
      const { covariate, value } = draw();

      exposures.push({
        app_id: "app_1",
        targeting_key_hash: targetingKeyHash,
        environment_id: "env_1",
        id_type: "user",
        run_id: RUN_ID,
        variant,
        first_exposure_ts: TS,
        window_anchor: TS,
      });
      if (metricType === "count" || value === 1) {
        metricValues.push({
          targeting_key_hash: targetingKeyHash,
          run_id: RUN_ID,
          metric_id: "m",
          metric_type: metricType,
          value,
          in_window: true,
        });
      }
      covariates.push({
        targeting_key_hash: targetingKeyHash,
        metric_id: "m",
        pre_period_value: covariate,
        covariate_source: "pre_period",
        observed_at: PRE_TS,
      });
    }
  }

  return estimateMetricComparison({
    run_id: RUN_ID,
    metric_id: "m",
    metric_type: metricType,
    control_variant: "control",
    treatment_variant: "treatment",
    exposures,
    metric_values: metricValues,
    pre_period_covariates: useCuped ? covariates : [],
    winsorize: false,
  });
}

function standardNormal(rand: () => number): number {
  const u = Math.max(rand(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
