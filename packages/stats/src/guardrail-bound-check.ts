import type { ArmResult, GuardrailResult } from "@splitch/contracts";

type GuardrailResultFields = Pick<
  ArmResult,
  "metric_id" | "variant" | "relative_lift_pct" | "ci_lower"
>;

export interface GuardrailThreshold {
  readonly metric_id: string;
  readonly variant: string;
  readonly downside_threshold: number;
  readonly guardrail_locked_at_run_start: boolean;
  readonly threshold_locked_at_run_start: boolean;
}

export interface GuardrailBoundCheckInput<Result extends GuardrailResultFields> {
  readonly arm_results: readonly Result[];
  readonly guardrails: readonly GuardrailThreshold[];
}

export function applyGuardrailBoundChecks<Result extends GuardrailResultFields>(
  input: GuardrailBoundCheckInput<Result>,
): GuardrailResult[] {
  const resultByKey = armResultsByGuardrailKey(input.arm_results);
  validateGuardrailKeys(input.guardrails);

  return input.guardrails.map((guardrail) => {
    validateThreshold(guardrail);
    const result = resultByKey.get(guardrailKey(guardrail));
    if (result === undefined) {
      throw new Error(`guardrail ${guardrail.metric_id}/${guardrail.variant} has no ArmResult.`);
    }

    const isBreached = breached(result, guardrail);
    return {
      metric_id: guardrail.metric_id,
      variant: guardrail.variant,
      ci_lower: result.ci_lower,
      threshold: guardrail.downside_threshold,
      is_breached: isBreached,
      in_bh_family: false,
      exploratory: !decisionValid(guardrail),
      decision_valid: decisionValid(guardrail),
      breach_reason:
        isBreached === true
          ? `CI lower bound ${result.ci_lower} < threshold ${guardrail.downside_threshold}`
          : null,
    };
  });
}

function armResultsByGuardrailKey<Result extends GuardrailResultFields>(
  results: readonly Result[],
): Map<string, Result> {
  const byKey = new Map<string, Result>();

  for (const result of results) {
    validateRelativeLiftCi(result);
    const key = guardrailKey(result);
    if (byKey.has(key)) {
      throw new Error(`arm_results contains duplicate guardrail member ${key}.`);
    }
    byKey.set(key, result);
  }

  return byKey;
}

function breached(result: GuardrailResultFields, guardrail: GuardrailThreshold): boolean | null {
  if (result.relative_lift_pct === null) {
    return null;
  }
  if (result.ci_lower === null) {
    throw new Error(
      `relative lift is defined for ${result.metric_id}/${result.variant}, but ci_lower is null.`,
    );
  }
  return result.ci_lower < guardrail.downside_threshold;
}

function decisionValid(guardrail: GuardrailThreshold): boolean {
  return guardrail.guardrail_locked_at_run_start && guardrail.threshold_locked_at_run_start;
}

function validateRelativeLiftCi(result: GuardrailResultFields): void {
  if (result.relative_lift_pct === null && result.ci_lower !== null) {
    throw new Error(
      `relative lift is undefined for ${result.metric_id}/${result.variant}, but ci_lower is set.`,
    );
  }
  if (result.relative_lift_pct !== null && result.ci_lower === null) {
    throw new Error(
      `relative lift is defined for ${result.metric_id}/${result.variant}, but ci_lower is null.`,
    );
  }
  if (result.ci_lower !== null && Number.isNaN(result.ci_lower)) {
    throw new Error(`ci_lower for ${result.metric_id}/${result.variant} must not be NaN.`);
  }
}

function validateThreshold(guardrail: GuardrailThreshold): void {
  if (
    Number.isNaN(guardrail.downside_threshold) ||
    !Number.isFinite(guardrail.downside_threshold)
  ) {
    throw new Error(
      `downside_threshold for ${guardrail.metric_id}/${guardrail.variant} must be finite.`,
    );
  }
}

function validateGuardrailKeys(guardrails: readonly GuardrailThreshold[]): void {
  const seen = new Set<string>();
  for (const guardrail of guardrails) {
    const key = guardrailKey(guardrail);
    if (seen.has(key)) {
      throw new Error(`guardrails contains duplicate member ${key}.`);
    }
    seen.add(key);
  }
}

function guardrailKey(member: Pick<GuardrailThreshold, "metric_id" | "variant">): string {
  return `${member.metric_id}/${member.variant}`;
}
