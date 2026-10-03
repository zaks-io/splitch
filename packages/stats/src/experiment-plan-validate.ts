import { EXPERIMENT_PLAN_MAX_ARM_COUNT } from "@splitch/contracts";
import type { ExperimentPlanInput, ExperimentPlanIssue } from "./experiment-plan-types";

const DEFAULT_ALPHA = 0.05;
const DEFAULT_POWER = 0.8;

export function validatePlanInput(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  return [
    ...validateBaseline(input),
    ...validateAlphaPower(input),
    ...validateArmAndTraffic(input),
    ...validateObjective(input),
    ...validateGuardrail(input),
    ...validateRelativeOnZeroBaseline(input),
    ...validateBinomialAlternative(input),
  ];
}

function validateBaseline(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  if (input.metricKind === "continuous") {
    return validateContinuousBaseline(input);
  }
  return validateBinomialBaseline(input);
}

function validateContinuousBaseline(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  const issues: ExperimentPlanIssue[] = [];
  if (input.baselineMean === undefined) {
    issues.push({
      path: ["baselineMean"],
      message: "baselineMean is required for continuous Metrics.",
    });
  }
  if (input.baselineVariance === undefined) {
    issues.push({
      path: ["baselineVariance"],
      message: "baselineVariance is required for continuous Metrics.",
    });
  } else if (!(Number.isFinite(input.baselineVariance) && input.baselineVariance > 0)) {
    issues.push({
      path: ["baselineVariance"],
      message: "baselineVariance must be finite and positive.",
    });
  }
  return issues;
}

function validateBinomialBaseline(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  if (input.baselineRate === undefined) {
    return [
      {
        path: ["baselineRate"],
        message: "baselineRate is required for binomial Metrics.",
      },
    ];
  }
  if (!(Number.isFinite(input.baselineRate) && input.baselineRate > 0 && input.baselineRate < 1)) {
    return [
      {
        path: ["baselineRate"],
        message: "baselineRate must be finite and in (0, 1).",
      },
    ];
  }
  return [];
}

function validateAlphaPower(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  const issues: ExperimentPlanIssue[] = [];
  const alpha = input.alpha ?? DEFAULT_ALPHA;
  const power = input.power ?? DEFAULT_POWER;
  if (!(Number.isFinite(alpha) && alpha > 0 && alpha < 1)) {
    issues.push({ path: ["alpha"], message: "alpha must be finite and in (0, 1)." });
  }
  if (!(Number.isFinite(power) && power > 0 && power < 1)) {
    issues.push({ path: ["power"], message: "power must be finite and in (0, 1)." });
  }
  if (
    !(
      Number.isFinite(input.expectedDailyEligibleEntities) &&
      input.expectedDailyEligibleEntities > 0
    )
  ) {
    issues.push({
      path: ["expectedDailyEligibleEntities"],
      message: "expectedDailyEligibleEntities must be finite and positive.",
    });
  }
  return issues;
}

function validateArmAndTraffic(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  const issues: ExperimentPlanIssue[] = [];
  if (
    !(
      Number.isInteger(input.armCount) &&
      input.armCount >= 2 &&
      input.armCount <= EXPERIMENT_PLAN_MAX_ARM_COUNT
    )
  ) {
    issues.push({
      path: ["armCount"],
      message: `armCount must be an integer in [2, ${EXPERIMENT_PLAN_MAX_ARM_COUNT}].`,
    });
  }
  if (input.trafficSplit !== undefined) {
    issues.push(...validateTrafficSplit(input.armCount, input.trafficSplit));
  }
  return issues;
}

function validateObjective(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  const issues: ExperimentPlanIssue[] = [];
  const hasAbs = input.mdeAbsolute !== undefined;
  const hasRel = input.mdeRelative !== undefined;
  const hasFixed = input.fixedSampleSizePerArm !== undefined;

  if (hasAbs && hasRel) {
    issues.push({
      path: ["mdeAbsolute"],
      message: "Provide mdeAbsolute or mdeRelative, not both.",
    });
  }
  if ((hasAbs || hasRel) === hasFixed) {
    issues.push({
      path: hasFixed ? ["fixedSampleSizePerArm"] : ["mdeAbsolute"],
      message:
        "Provide exactly one of: mdeAbsolute, mdeRelative, or fixedSampleSizePerArm. Observed effects are not accepted.",
    });
  }
  issues.push(...validateObjectiveMagnitudes(input, hasAbs, hasRel, hasFixed));
  return issues;
}

function validateObjectiveMagnitudes(
  input: ExperimentPlanInput,
  hasAbs: boolean,
  hasRel: boolean,
  hasFixed: boolean,
): ExperimentPlanIssue[] {
  const issues: ExperimentPlanIssue[] = [];
  if (hasAbs && !(Number.isFinite(input.mdeAbsolute) && (input.mdeAbsolute as number) > 0)) {
    issues.push({ path: ["mdeAbsolute"], message: "mdeAbsolute must be finite and positive." });
  }
  if (hasRel && !(Number.isFinite(input.mdeRelative) && (input.mdeRelative as number) > 0)) {
    issues.push({ path: ["mdeRelative"], message: "mdeRelative must be finite and positive." });
  }
  if (
    hasFixed &&
    !(Number.isInteger(input.fixedSampleSizePerArm) && (input.fixedSampleSizePerArm as number) > 0)
  ) {
    issues.push({
      path: ["fixedSampleSizePerArm"],
      message: "fixedSampleSizePerArm must be a positive integer.",
    });
  }
  return issues;
}

function validateTrafficSplit(armCount: number, split: readonly number[]): ExperimentPlanIssue[] {
  if (split.length !== armCount) {
    return [
      {
        path: ["trafficSplit"],
        message: `trafficSplit length must equal armCount (${armCount}).`,
      },
    ];
  }
  if (split.some((share) => !(Number.isFinite(share) && share > 0))) {
    return [
      { path: ["trafficSplit"], message: "trafficSplit shares must be finite and positive." },
    ];
  }
  const sum = split.reduce((acc, share) => acc + share, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    return [{ path: ["trafficSplit"], message: `trafficSplit shares must sum to 1 (got ${sum}).` }];
  }
  return [];
}

function validateGuardrail(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  const issues: ExperimentPlanIssue[] = [];
  if (
    input.guardrailBreachAbsolute !== undefined &&
    !(Number.isFinite(input.guardrailBreachAbsolute) && input.guardrailBreachAbsolute > 0)
  ) {
    issues.push({
      path: ["guardrailBreachAbsolute"],
      message: "guardrailBreachAbsolute must be finite and positive.",
    });
  }
  if (
    input.guardrailBreachRelative !== undefined &&
    !(Number.isFinite(input.guardrailBreachRelative) && input.guardrailBreachRelative > 0)
  ) {
    issues.push({
      path: ["guardrailBreachRelative"],
      message: "guardrailBreachRelative must be finite and positive.",
    });
  }
  if (input.guardrailBreachAbsolute !== undefined && input.guardrailBreachRelative !== undefined) {
    issues.push({
      path: ["guardrailBreachAbsolute"],
      message: "Provide guardrailBreachAbsolute or guardrailBreachRelative, not both.",
    });
  }
  return issues;
}

function validateRelativeOnZeroBaseline(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  const issues: ExperimentPlanIssue[] = [];
  const baselineMean = input.metricKind === "continuous" ? input.baselineMean : input.baselineRate;
  if (baselineMean !== 0) return issues;

  if (input.mdeRelative !== undefined) {
    issues.push({
      path: ["mdeAbsolute"],
      message: "mdeRelative requires a non-zero baseline; provide mdeAbsolute instead.",
    });
  }
  if (input.guardrailBreachRelative !== undefined) {
    issues.push({
      path: ["guardrailBreachAbsolute"],
      message:
        "guardrailBreachRelative requires a non-zero baseline; provide guardrailBreachAbsolute instead.",
    });
  }
  return issues;
}

function validateBinomialAlternative(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  const issues: ExperimentPlanIssue[] = [];
  const mdeAbsolute = binomialMdeAbsolute(input);
  if (mdeAbsolute !== undefined) {
    const alternativeRate = (input.baselineRate as number) + mdeAbsolute;
    if (!(alternativeRate > 0 && alternativeRate < 1)) {
      issues.push({
        path: input.mdeAbsolute !== undefined ? ["mdeAbsolute"] : ["mdeRelative"],
        message: "Alternative treatment rate (baselineRate + MDE) must be in (0, 1).",
      });
    }
  }
  issues.push(...validateBinomialGuardrailBreach(input));
  return issues;
}

function validateBinomialGuardrailBreach(input: ExperimentPlanInput): ExperimentPlanIssue[] {
  if (input.metricKind !== "binomial" || input.baselineRate === undefined) return [];
  const breach = binomialGuardrailBreach(input);
  if (breach === undefined) return [];
  const alternativeRate = input.baselineRate + breach;
  if (alternativeRate > 0 && alternativeRate < 1) return [];
  return [
    {
      path:
        input.guardrailBreachAbsolute !== undefined
          ? ["guardrailBreachAbsolute"]
          : ["guardrailBreachRelative"],
      message: "Guardrail breach alternative rate (baselineRate + breach) must be in (0, 1).",
    },
  ];
}

function binomialGuardrailBreach(input: ExperimentPlanInput): number | undefined {
  if (input.guardrailBreachAbsolute !== undefined) {
    return Number.isFinite(input.guardrailBreachAbsolute) && input.guardrailBreachAbsolute > 0
      ? input.guardrailBreachAbsolute
      : undefined;
  }
  if (input.guardrailBreachRelative === undefined || input.baselineRate === undefined) {
    return undefined;
  }
  const resolved = input.guardrailBreachRelative * Math.abs(input.baselineRate);
  return Number.isFinite(resolved) && resolved > 0 ? resolved : undefined;
}

function binomialMdeAbsolute(input: ExperimentPlanInput): number | undefined {
  if (input.metricKind !== "binomial") return undefined;
  if (input.baselineRate === undefined) return undefined;
  if (input.fixedSampleSizePerArm !== undefined) return undefined;
  if (input.mdeAbsolute !== undefined) {
    return Number.isFinite(input.mdeAbsolute) && input.mdeAbsolute > 0
      ? input.mdeAbsolute
      : undefined;
  }
  if (input.mdeRelative === undefined) return undefined;
  const resolved = input.mdeRelative * Math.abs(input.baselineRate);
  return Number.isFinite(resolved) && resolved > 0 ? resolved : undefined;
}
