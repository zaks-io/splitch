import { applyGuardrailBoundChecks } from "./guardrail-bound-check";
import { fiellerRelativeCi, type RelativeCiBounds } from "./relative-ci";
import { deltaMethodRelativeCi } from "./relative-ci-delta";
import {
  FIELLER_CONTROL,
  FIELLER_METRIC_ID,
  FIELLER_RUN_ID,
  FIELLER_TREATMENT,
  lookAtRelative,
  type RelativeDrawSpec,
  type RelativeExperimentDraw,
} from "./relative-ci-simulation-draws";
import { type CIResult, computeSequentialCI } from "./sequential-ci";
import type { MetricComparisonEstimate } from "./variance-estimator-types";
import { estimateMetricComparison } from "./variance-estimators";

export const FIELLER_SIMULATION_ALPHA = 0.05;
const FIELLER_GUARDRAIL_THRESHOLD_PCT = -10;

export interface RelativeCoverageConfig {
  readonly seed: string;
  readonly iterations: number;
  readonly lookSchedule: readonly number[];
  readonly spec: RelativeDrawSpec;
  readonly target_n?: number;
}

export type IntervalMethod = "fieller" | "delta";
export type TrialClass = "undefined" | "unbounded" | "cover" | "miss";

export function classifyLook(
  config: RelativeCoverageConfig,
  draw: RelativeExperimentDraw,
  look: number,
  truth: number | null,
  method: IntervalMethod,
): TrialClass {
  const evaluated = evaluateLook(config, draw, look);
  if (truth === null) {
    rejectPublishedUndefinedLift(evaluated);
    return "undefined";
  }
  if (!evaluated) return "undefined";
  const bounds = intervalFor(evaluated.comparison, evaluated.decision, method);
  if (bounds === null) return "undefined";
  rejectNanBounds(bounds, method, look);
  if (!Number.isFinite(bounds.lower) || !Number.isFinite(bounds.upper)) return "unbounded";
  return truth >= bounds.lower && truth <= bounds.upper ? "cover" : "miss";
}

export function trialGuardrail(
  config: RelativeCoverageConfig,
  draw: RelativeExperimentDraw,
  method: IntervalMethod,
): { everBreach: boolean; lastLookBreach: boolean; undetermined: boolean } {
  let everBreach = false;
  let lastLookBreach = false;
  let undetermined = true;
  const lastLook = config.lookSchedule[config.lookSchedule.length - 1];
  for (const look of config.lookSchedule) {
    const evaluated = evaluateLook(config, draw, look);
    if (!evaluated) continue;
    const bounds = intervalFor(evaluated.comparison, evaluated.decision, method);
    const breach = guardrailBreach(evaluated.comparison, bounds);
    if (breach === null) continue;
    undetermined = false;
    if (breach) everBreach = true;
    if (look === lastLook) lastLookBreach = breach;
  }
  return { everBreach, lastLookBreach, undetermined };
}

function evaluateLook(
  config: RelativeCoverageConfig,
  draw: RelativeExperimentDraw,
  look: number,
): { comparison: MetricComparisonEstimate; decision: CIResult } | null {
  const rows = lookAtRelative(draw, look);
  const comparison = estimateMetricComparison({
    run_id: FIELLER_RUN_ID,
    metric_id: FIELLER_METRIC_ID,
    metric_type: config.spec.kind,
    control_variant: FIELLER_CONTROL,
    treatment_variant: FIELLER_TREATMENT,
    exposures: rows.exposures,
    metric_values: rows.metricValues,
    pre_period_covariates: config.spec.cuped ? rows.covariates : [],
    cuped: config.spec.cuped,
    winsorize: false,
  });
  if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
    return null;
  }
  return {
    comparison,
    decision: computeSequentialCI({
      estimate: comparison.absolute_lift,
      sampling_var: comparison.absolute_lift_sampling_var,
      n_t: comparison.treatment.sample_size_n,
      n_c: comparison.control.sample_size_n,
      alpha: FIELLER_SIMULATION_ALPHA,
      target_n: config.target_n ?? Math.max(...config.lookSchedule),
    }),
  };
}

function intervalFor(
  comparison: MetricComparisonEstimate,
  decision: CIResult,
  method: IntervalMethod,
): RelativeCiBounds | null {
  if (comparison.relative_lift_pct === null) return null;
  if (method === "fieller") return fiellerRelativeCi(comparison, decision);
  return deltaMethodRelativeCi(comparison, decision);
}

function guardrailBreach(
  comparison: MetricComparisonEstimate,
  bounds: RelativeCiBounds | null,
): boolean | null {
  const [result] = applyGuardrailBoundChecks({
    arm_results: [
      {
        metric_id: FIELLER_METRIC_ID,
        variant: FIELLER_TREATMENT,
        relative_lift_pct: comparison.relative_lift_pct,
        ci_lower: comparison.relative_lift_pct === null ? null : (bounds?.lower ?? null),
        status: "ready",
      },
    ],
    guardrails: [
      {
        metric_id: FIELLER_METRIC_ID,
        variant: FIELLER_TREATMENT,
        downside_threshold_pct: FIELLER_GUARDRAIL_THRESHOLD_PCT,
        guardrail_locked_at_run_start: true,
        threshold_locked_at_run_start: true,
      },
    ],
  });
  return result?.is_breached ?? null;
}

function rejectPublishedUndefinedLift(
  evaluated: { comparison: MetricComparisonEstimate } | null,
): void {
  if (evaluated !== null && evaluated.comparison.relative_lift_pct !== null) {
    throw new Error(
      `relative lift is undefined when the Control mean is 0, but the estimator published ${evaluated.comparison.relative_lift_pct}.`,
    );
  }
}

function rejectNanBounds(bounds: RelativeCiBounds, method: IntervalMethod, look: number): void {
  if (Number.isNaN(bounds.lower) || Number.isNaN(bounds.upper)) {
    throw new Error(
      `${method} relative interval produced NaN at look ${look}; relative lift is undefined and must stay unpublished.`,
    );
  }
}
