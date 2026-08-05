import type { CIAdapter } from "./sequential-ci";
import { fixedHorizonPValue } from "./fixed-horizon-ci";
import {
  drawNullExperiment,
  lookAt,
  type NullExperimentDraw,
  seededNormal,
  SIMULATION_CONTROL_VARIANT,
  SIMULATION_METRIC_ID,
  SIMULATION_METRIC_TYPE,
  SIMULATION_RUN_ID,
  SIMULATION_TREATMENT_VARIANT,
} from "./simulation-null-draws";
import { estimateMetricComparison } from "./variance-estimators";

/**
 * The variance-reduction knobs the certified draw runs under. Omitting them
 * selects the engine defaults, which is what a Metric that states no preference
 * gets in production; a case that wants the layer off says so explicitly.
 */
interface SimulationVarianceConfig {
  readonly winsorize?: boolean;
  readonly winsorize_pct?: number;
}

export interface RepeatedLookSimulationConfig extends SimulationVarianceConfig {
  readonly adapter: CIAdapter;
  readonly method: "sequential" | "fixed-horizon";
  readonly alpha: number;
  readonly seed: string;
  readonly iterations: number;
  readonly lookSchedule: readonly number[];
  readonly target_n?: number;
}

export interface FixedHorizonSimulationConfig extends SimulationVarianceConfig {
  readonly adapter: CIAdapter;
  readonly alpha: number;
  readonly seed: string;
  readonly iterations: number;
  readonly sample_size_locked: number;
}

export interface RepeatedLookSimulationResult {
  readonly method: "sequential" | "fixed-horizon";
  readonly seed: string;
  readonly iterations: number;
  readonly rejections: number;
  readonly rejectionRate: number;
  readonly alpha: number;
  readonly lookSchedule: readonly number[];
}

export interface FixedHorizonSimulationResult {
  readonly method: "fixed";
  readonly seed: string;
  readonly iterations: number;
  readonly rejections: number;
  readonly rejectionRate: number;
  readonly alpha: number;
  readonly sample_size_locked: number;
}

interface NullComparison {
  readonly estimate: number;
  readonly sampling_var: number;
  readonly n_t: number;
  readonly n_c: number;
}

export function runRepeatedLookSimulation(
  config: RepeatedLookSimulationConfig,
): RepeatedLookSimulationResult {
  const rng = seededNormal(config.seed);
  let rejections = 0;

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    if (runOneNullExperiment(config, rng)) {
      rejections += 1;
    }
  }

  return {
    method: config.method,
    seed: config.seed,
    iterations: config.iterations,
    rejections,
    rejectionRate: rejections / config.iterations,
    alpha: config.alpha,
    lookSchedule: config.lookSchedule,
  };
}

export function runFixedHorizonSimulation(
  config: FixedHorizonSimulationConfig,
): FixedHorizonSimulationResult {
  const rng = seededNormal(config.seed);
  let rejections = 0;

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    if (runOneLockedNullExperiment(config, rng)) {
      rejections += 1;
    }
  }

  return {
    method: "fixed",
    seed: config.seed,
    iterations: config.iterations,
    rejections,
    rejectionRate: rejections / config.iterations,
    alpha: config.alpha,
    sample_size_locked: config.sample_size_locked,
  };
}

function runOneNullExperiment(config: RepeatedLookSimulationConfig, rng: () => number): boolean {
  const draw = drawNullExperiment(rng, Math.max(...config.lookSchedule));

  for (const look of config.lookSchedule) {
    if (pValueAtLook(config, draw, look) <= config.alpha) {
      return true;
    }
  }

  return false;
}

function runOneLockedNullExperiment(
  config: FixedHorizonSimulationConfig,
  rng: () => number,
): boolean {
  const draw = drawNullExperiment(rng, config.sample_size_locked);
  const comparison = nullComparison(config, draw, config.sample_size_locked);
  const result = config.adapter.compute({
    ...comparison,
    alpha: config.alpha,
    sample_size_locked: config.sample_size_locked,
  });

  if (result.mode !== "fixed" || result.peeking_allowed) {
    throw new Error("fixed-horizon simulation requires a non-peeking fixed adapter.");
  }

  return result.p_value <= config.alpha;
}

function pValueAtLook(
  config: RepeatedLookSimulationConfig,
  draw: NullExperimentDraw,
  look: number,
): number {
  const comparison = nullComparison(config, draw, look);

  if (config.method === "fixed-horizon") {
    return fixedHorizonPValue(comparison.estimate, Math.sqrt(comparison.sampling_var));
  }

  return config.adapter.compute({
    ...comparison,
    alpha: config.alpha,
    target_n: config.target_n,
  }).p_value;
}

/**
 * The absolute lift and its sampling variance exactly as `analyzeMetricArmResults`
 * hands them to a CI adapter, so a defect in the estimator moves the certified
 * Type-I rate instead of hiding behind a variance the simulation recomputed.
 */
function nullComparison(
  config: SimulationVarianceConfig,
  draw: NullExperimentDraw,
  look: number,
): NullComparison {
  const rows = lookAt(draw, look);
  const comparison = estimateMetricComparison({
    run_id: SIMULATION_RUN_ID,
    metric_id: SIMULATION_METRIC_ID,
    metric_type: SIMULATION_METRIC_TYPE,
    control_variant: SIMULATION_CONTROL_VARIANT,
    treatment_variant: SIMULATION_TREATMENT_VARIANT,
    exposures: rows.exposures,
    metric_values: rows.metricValues,
    winsorize: config.winsorize,
    winsorize_pct: config.winsorize_pct,
  });

  if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
    throw new Error(
      `null simulation produced no absolute lift at look ${look}; the estimator refused a complete draw.`,
    );
  }

  return {
    estimate: comparison.absolute_lift,
    sampling_var: comparison.absolute_lift_sampling_var,
    n_t: comparison.treatment.sample_size_n,
    n_c: comparison.control.sample_size_n,
  };
}

export function monteCarloTolerance(alpha: number, iterations: number): number {
  return Math.max(0.02, 3 * Math.sqrt((alpha * (1 - alpha)) / iterations));
}

export function meetsAlwaysValidBound(
  result: RepeatedLookSimulationResult,
  tolerance: number,
): boolean {
  return result.rejectionRate <= result.alpha + tolerance;
}
