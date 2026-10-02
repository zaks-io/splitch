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
  return classifyEvaluatedLook(evaluateLook(config, draw, look), truth, method, look);
}

/**
 * Classifies one look after estimation. Exported so regression tests can feed a
 * missing relative estimate or CI error without rewriting the variance path.
 */
export function classifyEvaluatedLook(
  evaluated: { comparison: MetricComparisonEstimate; decision: CIResult } | null,
  truth: number | null,
  method: IntervalMethod,
  look: number,
): TrialClass {
  if (truth === null) {
    rejectPublishedUndefinedLift(evaluated);
    return "undefined";
  }
  const ready = requireDefinedLook(evaluated, method, look);
  rejectNanBounds(ready.bounds, method, look);
  if (!Number.isFinite(ready.bounds.lower) || !Number.isFinite(ready.bounds.upper)) {
    return "unbounded";
  }
  return truth >= ready.bounds.lower && truth <= ready.bounds.upper ? "cover" : "miss";
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
    const breach = lookGuardrailBreach(config, draw, look, method);
    if (breach === null) continue;
    undetermined = false;
    if (breach) everBreach = true;
    if (look === lastLook) lastLookBreach = breach;
  }
  return { everBreach, lastLookBreach, undetermined };
}

function lookGuardrailBreach(
  config: RelativeCoverageConfig,
  draw: RelativeExperimentDraw,
  look: number,
  method: IntervalMethod,
): boolean | null {
  const evaluated = evaluateLook(config, draw, look);
  if (!evaluated) return null;
  if (evaluated.decision.status === "error") {
    throw new Error(
      `Guardrail look ${look} sequential CI failed: ${evaluated.decision.error?.message ?? "unknown error"}.`,
    );
  }
  return guardrailBreach(
    evaluated.comparison,
    intervalFor(evaluated.comparison, evaluated.decision, method),
  );
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

function requireDefinedLook(
  evaluated: { comparison: MetricComparisonEstimate; decision: CIResult } | null,
  method: IntervalMethod,
  look: number,
): {
  comparison: MetricComparisonEstimate;
  decision: CIResult;
  bounds: RelativeCiBounds;
} {
  if (evaluated === null) {
    throw new Error(
      `relative coverage look ${look} produced no absolute estimate while the true relative lift is defined.`,
    );
  }
  if (evaluated.decision.status === "error") {
    throw new Error(
      `relative coverage look ${look} sequential CI failed: ${evaluated.decision.error?.message ?? "unknown error"}.`,
    );
  }
  const bounds = intervalFor(evaluated.comparison, evaluated.decision, method);
  if (bounds === null) {
    throw new Error(
      `relative coverage look ${look} produced no ${method} relative interval while the true relative lift is defined.`,
    );
  }
  return { comparison: evaluated.comparison, decision: evaluated.decision, bounds };
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
