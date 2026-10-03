import type {
  DecisionFamilyMember,
  DedupeExposureRow,
  PerEntityMetricRow,
} from "@splitch/contracts";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr";
import { armResult } from "./decision-family-fdr-test-helpers";
import {
  assertGeneratedMetricCorrelation,
  FAMILY_FDR_SIM_CORRELATION,
  FAMILY_FDR_SIM_CORRELATION_CHECK_N,
  FAMILY_FDR_SIM_CORRELATION_TOLERANCE,
  familyFdrSimFactorLoadings,
} from "./decision-family-fdr-simulation-correlation";
import type { FamilyCorrectionProcedure } from "./family-correction";
import { SequentialCI } from "./sequential-ci";
import {
  lookAt,
  seededNormal,
  SIMULATION_CONTROL_VARIANT,
  SIMULATION_METRIC_TYPE,
  SIMULATION_RUN_ID,
  SIMULATION_TREATMENT_VARIANT,
  type NullExperimentDraw,
} from "./simulation-null-draws";
import { estimateMetricComparison } from "./variance-estimators";

export const FAMILY_FDR_SIM_ALPHA = 0.05;
const FAMILY_FDR_SIM_ALTERNATIVE_EFFECT = 0.35;
const FAMILY_FDR_SIM_TARGET_N = 1_250;
export const FAMILY_FDR_SIM_SMOKE_LOOKS = [100, 200, 400] as const;
export const FAMILY_FDR_SIM_AUDIT_LOOKS = [100, 200, 400, 700, 1_250] as const;

const TREATMENT = SIMULATION_TREATMENT_VARIANT;
const METRICS = [
  { metric_id: "goal_null_a", effect: 0, is_null: true },
  { metric_id: "goal_null_b", effect: 0, is_null: true },
  { metric_id: "goal_alt_a", effect: FAMILY_FDR_SIM_ALTERNATIVE_EFFECT, is_null: false },
  { metric_id: "goal_alt_b", effect: FAMILY_FDR_SIM_ALTERNATIVE_EFFECT, is_null: false },
] as const;

const DECISION_FAMILY: DecisionFamilyMember[] = METRICS.map((metric) => ({
  metric_id: metric.metric_id,
  variant: TREATMENT,
}));

const NULL_METRIC_IDS = new Set<string>(
  METRICS.filter((metric) => metric.is_null).map((metric) => metric.metric_id),
);

export interface FamilyCorrectionSimulationConfig {
  readonly seed: string;
  readonly iterations: number;
  readonly lookSchedule: readonly number[];
}

interface ProcedureSimulationStats {
  readonly observedFdr: number;
  readonly power: number;
}

export interface FamilyCorrectionSimulationResult {
  readonly seed: string;
  readonly iterations: number;
  readonly alpha: number;
  readonly correlation: number;
  readonly lookSchedule: readonly number[];
  readonly bh: ProcedureSimulationStats;
  readonly bh_g: ProcedureSimulationStats;
  /** Stop-policy power(BH) minus power(BH-G). Negative when BH-G waits and later rejects more alternatives. */
  readonly stopPowerCost: number;
  readonly lastLookBh: ProcedureSimulationStats;
  readonly lastLookBhG: ProcedureSimulationStats;
  readonly lastLookPowerCost: number;
}

interface Accumulator {
  fdrSum: number;
  truePositiveSum: number;
}

export function runFamilyCorrectionStoppingSimulation(
  config: FamilyCorrectionSimulationConfig,
): FamilyCorrectionSimulationResult {
  assertGeneratedMetricCorrelation(
    seededNormal(`${config.seed}:correlation-check`),
    FAMILY_FDR_SIM_CORRELATION,
    FAMILY_FDR_SIM_CORRELATION_CHECK_N,
    FAMILY_FDR_SIM_CORRELATION_TOLERANCE,
  );

  const rng = seededNormal(config.seed);
  const adapter = new SequentialCI();
  const bh = emptyAccumulator();
  const bhG = emptyAccumulator();
  const lastBh = emptyAccumulator();
  const lastBhG = emptyAccumulator();
  const maxLook = Math.max(...config.lookSchedule);

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const draw = drawCorrelatedGoals(rng, maxLook);
    const pValuesByLook = config.lookSchedule.map((look) =>
      DECISION_FAMILY.map((member) => pValueAtLook(adapter, draw, look, member.metric_id)),
    );
    const lastLook = pValuesByLook[pValuesByLook.length - 1];
    if (lastLook === undefined) {
      throw new Error("family FDR simulation requires a non-empty look schedule.");
    }
    accumulateTrial(bh, firstCrossing(pValuesByLook, "bh"));
    accumulateTrial(bhG, firstCrossing(pValuesByLook, "bh_g"));
    accumulateTrial(lastBh, firstCrossing([lastLook], "bh"));
    accumulateTrial(lastBhG, firstCrossing([lastLook], "bh_g"));
  }

  const alternativeCount = config.iterations * (METRICS.length - NULL_METRIC_IDS.size);
  const bhStats = toStats(bh, config.iterations, alternativeCount);
  const bhGStats = toStats(bhG, config.iterations, alternativeCount);
  const lastLookBh = toStats(lastBh, config.iterations, alternativeCount);
  const lastLookBhG = toStats(lastBhG, config.iterations, alternativeCount);

  return {
    seed: config.seed,
    iterations: config.iterations,
    alpha: FAMILY_FDR_SIM_ALPHA,
    correlation: FAMILY_FDR_SIM_CORRELATION,
    lookSchedule: config.lookSchedule,
    bh: bhStats,
    bh_g: bhGStats,
    stopPowerCost: bhStats.power - bhGStats.power,
    lastLookBh,
    lastLookBhG,
    lastLookPowerCost: lastLookBh.power - lastLookBhG.power,
  };
}

function firstCrossing(
  pValuesByLook: readonly (readonly number[])[],
  procedure: FamilyCorrectionProcedure,
): { falseDiscoveries: number; discoveries: number; truePositives: number } {
  for (const pValues of pValuesByLook) {
    if (pValues.length !== DECISION_FAMILY.length) {
      throw new Error("family FDR simulation look is missing a locked family p-value.");
    }
    const output = applyDecisionFamilyCorrection({
      confidence_level: 1 - FAMILY_FDR_SIM_ALPHA,
      decision_family: DECISION_FAMILY,
      family_correction: procedure,
      arm_results: DECISION_FAMILY.map((member, index) => {
        const pValue = pValues[index];
        if (pValue === undefined) {
          throw new Error(`family FDR simulation missing p-value for ${member.metric_id}.`);
        }
        return armResult(member.metric_id, member.variant, pValue);
      }),
    });
    const rejected = output.arm_results.filter((result) => result.is_significant);
    if (rejected.length === 0) {
      continue;
    }

    const falseDiscoveries = rejected.filter((result) =>
      NULL_METRIC_IDS.has(result.metric_id),
    ).length;
    return {
      falseDiscoveries,
      discoveries: rejected.length,
      truePositives: rejected.length - falseDiscoveries,
    };
  }

  return { falseDiscoveries: 0, discoveries: 0, truePositives: 0 };
}

function pValueAtLook(
  adapter: SequentialCI,
  draw: NullExperimentDraw,
  look: number,
  metricId: string,
): number {
  const rows = lookAt(filterMetric(draw, metricId), look);
  const comparison = estimateMetricComparison({
    run_id: SIMULATION_RUN_ID,
    metric_id: metricId,
    metric_type: SIMULATION_METRIC_TYPE,
    control_variant: SIMULATION_CONTROL_VARIANT,
    treatment_variant: TREATMENT,
    exposures: rows.exposures,
    metric_values: rows.metricValues,
    winsorize: false,
    cuped: false,
  });

  if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
    throw new Error(
      `family FDR simulation produced no absolute lift for ${metricId} at look ${look}.`,
    );
  }

  const result = adapter.compute({
    estimate: comparison.absolute_lift,
    sampling_var: comparison.absolute_lift_sampling_var,
    n_t: comparison.treatment.sample_size_n,
    n_c: comparison.control.sample_size_n,
    alpha: FAMILY_FDR_SIM_ALPHA,
    target_n: FAMILY_FDR_SIM_TARGET_N,
  });

  if (result.status !== "ok") {
    throw new Error(`SequentialCI refused ${metricId} at look ${look}: ${result.status}.`);
  }

  return result.p_value;
}

function drawCorrelatedGoals(rng: () => number, size: number): NullExperimentDraw {
  const { sharedLoading, residualLoading } = familyFdrSimFactorLoadings(FAMILY_FDR_SIM_CORRELATION);
  const exposures: DedupeExposureRow[] = [];
  const metricValues: PerEntityMetricRow[] = [];

  for (let index = 0; index < size; index += 1) {
    for (const variant of [TREATMENT, SIMULATION_CONTROL_VARIANT] as const) {
      const targetingKeyHash = `${variant}_${index}`;
      exposures.push({
        app_id: "app_simulation",
        targeting_key_hash: targetingKeyHash,
        environment_id: "env_simulation",
        id_type: "user",
        run_id: SIMULATION_RUN_ID,
        variant,
        first_exposure_ts: "2026-01-01T00:00:00.000Z",
        first_ingest_ts: "2026-01-01T00:00:00.000Z",
        window_anchor: "2026-01-01T00:00:00.000Z",
      });
      const shared = rng();
      for (const metric of METRICS) {
        const residual = rng();
        const treatmentShift = variant === TREATMENT ? metric.effect : 0;
        metricValues.push({
          targeting_key_hash: targetingKeyHash,
          run_id: SIMULATION_RUN_ID,
          metric_id: metric.metric_id,
          metric_type: SIMULATION_METRIC_TYPE,
          value: sharedLoading * shared + residualLoading * residual + treatmentShift,
          in_window: true,
        });
      }
    }
  }

  return { exposures, metricValues };
}

function filterMetric(draw: NullExperimentDraw, metricId: string): NullExperimentDraw {
  return {
    exposures: draw.exposures,
    metricValues: draw.metricValues.filter((row) => row.metric_id === metricId),
  };
}

function emptyAccumulator(): Accumulator {
  return { fdrSum: 0, truePositiveSum: 0 };
}

function accumulateTrial(
  acc: Accumulator,
  trial: { falseDiscoveries: number; discoveries: number; truePositives: number },
): void {
  acc.fdrSum += trial.discoveries === 0 ? 0 : trial.falseDiscoveries / trial.discoveries;
  acc.truePositiveSum += trial.truePositives;
}

function toStats(
  acc: Accumulator,
  iterations: number,
  alternativeCount: number,
): ProcedureSimulationStats {
  if (alternativeCount === 0) {
    throw new Error("family FDR simulation requires mixed nulls with at least one alternative.");
  }
  return {
    observedFdr: acc.fdrSum / iterations,
    power: acc.truePositiveSum / alternativeCount,
  };
}
