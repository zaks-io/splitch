import type { ArmResult, GuardrailResult } from "@splitch/contracts";
import { DEFAULT_SEQUENTIAL_TARGET_N } from "@splitch/contracts";
import type { GuardrailThreshold } from "./guardrail-bound-check";
import { contrastKey, type GuardrailContrastKey } from "./guardrail-contrasts";
import { evaluateOneSidedGuardrail, type GuardrailVerdict } from "./guardrail-one-sided";
import type { MetricComparisonEstimate } from "./variance-estimator-types";

export interface OneSidedGuardrailApplyInput {
  readonly arm_results: readonly Pick<
    ArmResult,
    "metric_id" | "variant" | "relative_lift_pct" | "status"
  >[];
  readonly guardrails: readonly GuardrailThreshold[];
  readonly contrasts: ReadonlyMap<GuardrailContrastKey, MetricComparisonEstimate>;
  readonly alpha: number;
  readonly target_n: number | undefined;
  readonly horizon: "sequential" | "fixed";
}

/**
 * analysis-v2 Guardrail path: Proposition B.1 one-sided bounds on the relative
 * non-inferiority contrast. Arm status still gates decisionability so a
 * not-ready Arm stays unevaluated (is_breached null).
 */
export function applyOneSidedGuardrailBoundChecks(
  input: OneSidedGuardrailApplyInput,
): GuardrailResult[] {
  const statusByKey = armStatusByKey(input.arm_results);
  validateGuardrailKeys(input.guardrails);

  return input.guardrails.map((guardrail) =>
    oneSidedGuardrailResult(guardrail, statusByKey, input),
  );
}

function oneSidedGuardrailResult(
  guardrail: GuardrailThreshold,
  statusByKey: ReadonlyMap<string, string>,
  input: OneSidedGuardrailApplyInput,
): GuardrailResult {
  validateThreshold(guardrail);
  const key = contrastKey(guardrail.metric_id, guardrail.variant);
  const status = statusByKey.get(key);
  if (status === undefined) {
    throw new Error(`guardrail ${key} has no ArmResult.`);
  }
  const comparison = input.contrasts.get(key);
  if (comparison === undefined) {
    throw new Error(`guardrail ${key} has no contrast estimate.`);
  }

  const decisionable = status === "ready" || status === "stopped";
  const evaluated =
    decisionable && comparison.relative_lift_pct !== null
      ? evaluateFromComparison(comparison, guardrail, input)
      : null;
  const isBreached = evaluated === null ? null : verdictToBreached(evaluated.verdict);

  return {
    metric_id: guardrail.metric_id,
    variant: guardrail.variant,
    ci_lower: evaluated?.relativeLowerPct ?? null,
    threshold: guardrail.downside_threshold_pct,
    is_breached: isBreached,
    in_bh_family: false,
    exploratory: !decisionValid(guardrail),
    decision_valid: decisionValid(guardrail),
    breach_reason:
      isBreached === true
        ? `one-sided oriented contrast upper bound ${evaluated?.upper} < 0 at margin ${guardrail.downside_threshold_pct}%`
        : null,
  };
}

function evaluateFromComparison(
  comparison: MetricComparisonEstimate,
  guardrail: GuardrailThreshold,
  input: OneSidedGuardrailApplyInput,
) {
  const components = comparison.absolute_lift_var_components;
  const treatmentEstimate = comparison.treatment.point_estimate;
  const controlEstimate = comparison.control.point_estimate;
  if (
    components === null ||
    treatmentEstimate === null ||
    controlEstimate === null ||
    controlEstimate === 0
  ) {
    return null;
  }
  if (comparison.treatment.sample_size_n === 0 || comparison.control.sample_size_n === 0) {
    return null;
  }

  const targetN =
    input.horizon === "sequential"
      ? (input.target_n ?? DEFAULT_SEQUENTIAL_TARGET_N)
      : comparison.treatment.sample_size_n + comparison.control.sample_size_n;

  return evaluateOneSidedGuardrail({
    treatmentEstimate,
    controlEstimate,
    treatmentVar: components.treatment,
    controlVar: components.control,
    margin: guardrail.downside_threshold_pct / 100,
    alpha: input.alpha,
    n_t: comparison.treatment.sample_size_n,
    n_c: comparison.control.sample_size_n,
    target_n: targetN,
    horizon: input.horizon,
  });
}

function verdictToBreached(verdict: GuardrailVerdict): boolean | null {
  if (verdict === "safe") return false;
  if (verdict === "breach") return true;
  return null;
}

function armStatusByKey(results: OneSidedGuardrailApplyInput["arm_results"]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const result of results) {
    const key = contrastKey(result.metric_id, result.variant);
    if (byKey.has(key)) {
      throw new Error(`arm_results contains duplicate guardrail member ${key}.`);
    }
    byKey.set(key, result.status);
  }
  return byKey;
}

function decisionValid(guardrail: GuardrailThreshold): boolean {
  return guardrail.guardrail_locked_at_run_start && guardrail.threshold_locked_at_run_start;
}

function validateThreshold(guardrail: GuardrailThreshold): void {
  if (
    Number.isNaN(guardrail.downside_threshold_pct) ||
    !Number.isFinite(guardrail.downside_threshold_pct)
  ) {
    throw new Error(
      `downside_threshold_pct for ${guardrail.metric_id}/${guardrail.variant} must be finite.`,
    );
  }
}

function validateGuardrailKeys(guardrails: readonly GuardrailThreshold[]): void {
  const seen = new Set<string>();
  for (const guardrail of guardrails) {
    const key = contrastKey(guardrail.metric_id, guardrail.variant);
    if (seen.has(key)) {
      throw new Error(`guardrails contains duplicate member ${key}.`);
    }
    seen.add(key);
  }
}
