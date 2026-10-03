import { EXPERIMENT_PLAN_MAX_SAFE_COUNT } from "./experiment-plan-power";
import type { ExperimentPlanIssue, ExperimentPlanResult } from "./experiment-plan-types";

/**
 * One guard for every derived numeric on the response contract: finite, within
 * the wire bounds, and a safe integer where the contract uses `.int()`. Field-
 * specific VALIDATION_ERROR paths name the offending output.
 */
export function validatePlanOutputs(plan: ExperimentPlanResult): ExperimentPlanIssue[] {
  const issues: ExperimentPlanIssue[] = [];

  checkSafePositiveInt(issues, "fixedHorizonNPerArm", plan.fixedHorizonNPerArm);
  checkFinitePositive(issues, "alwaysValidInflation", plan.alwaysValidInflation);
  for (let i = 0; i < plan.nPerArm.length; i += 1) {
    checkSafePositiveInt(issues, "nPerArm", plan.nPerArm[i] as number, ["nPerArm", String(i)]);
  }
  checkSafePositiveInt(issues, "targetN", plan.targetN);
  checkSafePositiveInt(issues, "expectedDurationDays", plan.expectedDurationDays);
  checkFinitePositive(issues, "mdeAbsolute", plan.mdeAbsolute);
  if (plan.mdeRelative !== null) {
    checkFinitePositive(issues, "mdeRelative", plan.mdeRelative);
  }
  checkUnitIntervalOpen(issues, "alpha", plan.alpha);
  checkUnitIntervalOpen(issues, "power", plan.power);
  for (let i = 0; i < plan.comparisonPowers.length; i += 1) {
    checkUnitIntervalClosed(issues, "comparisonPowers", plan.comparisonPowers[i] as number, [
      "comparisonPowers",
      String(i),
    ]);
  }
  if (plan.guardrailPower !== null) {
    checkUnitIntervalClosed(issues, "guardrailPower", plan.guardrailPower);
  }
  if (!Number.isFinite(plan.baselineMean)) {
    issues.push({
      path: ["baselineMean"],
      message: "Derived baselineMean must be finite.",
    });
  }
  checkFinitePositive(issues, "baselineVariance", plan.baselineVariance);

  return issues;
}

function checkSafePositiveInt(
  issues: ExperimentPlanIssue[],
  label: string,
  value: number,
  path: readonly string[] = [label],
): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    issues.push({
      path,
      message: `Derived ${label} must be a positive safe integer at most ${EXPERIMENT_PLAN_MAX_SAFE_COUNT} (got ${String(value)}).`,
    });
  }
}

function checkFinitePositive(
  issues: ExperimentPlanIssue[],
  label: string,
  value: number,
  path: readonly string[] = [label],
): void {
  if (!(Number.isFinite(value) && value > 0)) {
    issues.push({
      path,
      message: `Derived ${label} must be finite and positive (got ${String(value)}).`,
    });
  }
}

function checkUnitIntervalOpen(
  issues: ExperimentPlanIssue[],
  label: string,
  value: number,
  path: readonly string[] = [label],
): void {
  if (!(Number.isFinite(value) && value > 0 && value < 1)) {
    issues.push({
      path,
      message: `Derived ${label} must be finite and in (0, 1) (got ${String(value)}).`,
    });
  }
}

function checkUnitIntervalClosed(
  issues: ExperimentPlanIssue[],
  label: string,
  value: number,
  path: readonly string[] = [label],
): void {
  if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
    issues.push({
      path,
      message: `Derived ${label} must be finite and in [0, 1] (got ${String(value)}).`,
    });
  }
}
