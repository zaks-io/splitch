import type { ExperimentPlanIssue } from "./experiment-plan-types";
import { normalCdf, normalSurvival } from "./normal-distribution";
import { normalMixtureScale, rhoSquaredForTargetN } from "./sequential-ci";

/** Same ceiling the response contract enforces via Zod `.int()` (safe integers). */
export const EXPERIMENT_PLAN_MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * Minimum Entities per arm for the planner's normal approximation. Below this,
 * theoretical power (and SequentialCI with estimated variance) is not trusted.
 */
const EXPERIMENT_PLAN_MIN_PER_ARM_N = 10;

/**
 * Minimum expected binomial successes and failures per arm under each planned
 * rate (classic np / n(1-p) ≥ 10 rule) before the normal approximation applies.
 */
const EXPERIMENT_PLAN_MIN_BINOMIAL_EXPECTED_COUNT = 10;

export function armAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`expected arm index ${index} in a plan with ${values.length} arms`);
  }
  return value;
}

function armsFromControl(controlN: number, split: readonly number[]): number[] {
  const controlShare = armAt(split, 0);
  return split.map((share) => Math.ceil(controlN * (share / controlShare)));
}

function unrepresentableCountIssue(path: readonly string[]): ExperimentPlanIssue {
  return {
    path,
    message: `Derived arm sample size or targetN exceeds the representable maximum (${EXPERIMENT_PLAN_MAX_SAFE_COUNT}).`,
  };
}

/**
 * Build per-arm counts from Control n and refuse values outside the safe-integer
 * range the wire contract accepts.
 */
export function representableArmCounts(
  controlN: number,
  split: readonly number[],
  issuePath: readonly string[],
):
  | { ok: true; nPerArm: number[]; targetN: number }
  | { ok: false; issues: readonly ExperimentPlanIssue[] } {
  if (!Number.isSafeInteger(controlN) || controlN < 1) {
    return { ok: false, issues: [unrepresentableCountIssue(issuePath)] };
  }
  const nPerArm = armsFromControl(controlN, split);
  for (const n of nPerArm) {
    if (!Number.isSafeInteger(n) || n < 1) {
      return { ok: false, issues: [unrepresentableCountIssue(issuePath)] };
    }
  }
  const targetN = armAt(nPerArm, 0) + armAt(nPerArm, 1);
  if (!Number.isSafeInteger(targetN) || targetN < 1) {
    return { ok: false, issues: [unrepresentableCountIssue(issuePath)] };
  }
  return { ok: true, nPerArm, targetN };
}

/**
 * Per-Entity outcome variances under the planned alternative. Continuous Metrics
 * use the same variance on both arms; binomial uses p0(1-p0) and p1(1-p1).
 * `mdeAbsolute` may be signed for binomial guardrail alternatives (rate shift).
 */
export function armVariances(args: {
  metricKind: "continuous" | "binomial";
  baselineVariance: number;
  baselineMean: number;
  mdeAbsolute: number;
}): { control: number; treatment: number } {
  if (args.metricKind === "continuous") {
    return { control: args.baselineVariance, treatment: args.baselineVariance };
  }
  const p0 = args.baselineMean;
  const p1 = p0 + args.mdeAbsolute;
  return { control: p0 * (1 - p0), treatment: p1 * (1 - p1) };
}

export function comparisonPower(args: {
  nControl: number;
  nTreatment: number;
  targetN: number;
  alpha: number;
  varianceControl: number;
  varianceTreatment: number;
  effectAbsolute: number;
}): number {
  const se = Math.sqrt(
    args.varianceControl / args.nControl + args.varianceTreatment / args.nTreatment,
  );
  const scale = normalMixtureScale(
    args.nControl + args.nTreatment,
    args.alpha,
    rhoSquaredForTargetN(args.alpha, args.targetN),
  );
  const deltaOverSe = args.effectAbsolute / se;
  return normalCdf(-scale - deltaOverSe) + normalSurvival(scale - deltaOverSe);
}

export function comparisonPowersForPlan(args: {
  nPerArm: readonly number[];
  targetN: number;
  alpha: number;
  varianceControl: number;
  varianceTreatment: number;
  effectAbsolute: number;
}): number[] {
  const nControl = armAt(args.nPerArm, 0);
  const powers: number[] = [];
  for (let index = 1; index < args.nPerArm.length; index += 1) {
    powers.push(
      comparisonPower({
        nControl,
        nTreatment: armAt(args.nPerArm, index),
        targetN: args.targetN,
        alpha: args.alpha,
        varianceControl: args.varianceControl,
        varianceTreatment: args.varianceTreatment,
        effectAbsolute: args.effectAbsolute,
      }),
    );
  }
  return powers;
}

/** Worst-case (minimum) two-sided power across Control-vs-treatment comparisons. */
export function minComparisonPower(args: {
  nPerArm: readonly number[];
  targetN: number;
  alpha: number;
  varianceControl: number;
  varianceTreatment: number;
  effectAbsolute: number;
}): number {
  return Math.min(...comparisonPowersForPlan(args));
}

/**
 * Refuse plans outside the asymptotic regime the normal power approximation
 * (and the engine's estimated-variance SequentialCI) supports. Continuous Metrics
 * need at least {@link EXPERIMENT_PLAN_MIN_PER_ARM_N} per arm; binomial Metrics
 * also need ≥ {@link EXPERIMENT_PLAN_MIN_BINOMIAL_EXPECTED_COUNT} expected
 * successes and failures under both the Control and treatment rates.
 */
export function validateAsymptoticSampleSize(args: {
  metricKind: "continuous" | "binomial";
  baselineMean: number;
  mdeAbsolute: number;
  nPerArm: readonly number[];
  issuePath: readonly string[];
}): ExperimentPlanIssue[] {
  for (let index = 0; index < args.nPerArm.length; index += 1) {
    const n = armAt(args.nPerArm, index);
    if (n < EXPERIMENT_PLAN_MIN_PER_ARM_N) {
      return [
        {
          path: args.issuePath,
          message:
            `Plan sample size is below the supported asymptotic regime ` +
            `(need at least ${EXPERIMENT_PLAN_MIN_PER_ARM_N} Entities per arm; ` +
            `arm ${index} has ${n}).`,
        },
      ];
    }
  }

  if (args.metricKind !== "binomial") return [];

  const controlRate = args.baselineMean;
  const treatmentRate = controlRate + args.mdeAbsolute;
  const rates = [controlRate, treatmentRate] as const;
  for (let index = 0; index < args.nPerArm.length; index += 1) {
    const n = armAt(args.nPerArm, index);
    // Control arm is checked under the baseline rate; every treatment under p1.
    const rate = index === 0 ? rates[0] : rates[1];
    const expectedSuccesses = n * rate;
    const expectedFailures = n * (1 - rate);
    if (
      expectedSuccesses < EXPERIMENT_PLAN_MIN_BINOMIAL_EXPECTED_COUNT ||
      expectedFailures < EXPERIMENT_PLAN_MIN_BINOMIAL_EXPECTED_COUNT
    ) {
      return [
        {
          path: args.issuePath,
          message:
            `Plan sample size is below the supported asymptotic regime for binomial Metrics ` +
            `(need n·p ≥ ${EXPERIMENT_PLAN_MIN_BINOMIAL_EXPECTED_COUNT} and ` +
            `n·(1-p) ≥ ${EXPERIMENT_PLAN_MIN_BINOMIAL_EXPECTED_COUNT} under both Control and ` +
            `treatment rates; arm ${index} at rate ${rate} has n·p=${expectedSuccesses} and ` +
            `n·(1-p)=${expectedFailures}).`,
        },
      ];
    }
  }
  return [];
}

/** Calendar days until every arm reaches its planned n under the traffic split. */
export function expectedDurationDaysForSplit(args: {
  nPerArm: readonly number[];
  trafficSplit: readonly number[];
  expectedDailyEligibleEntities: number;
}): number {
  let maxDays = 0;
  for (let index = 0; index < args.nPerArm.length; index += 1) {
    const dailyShare = args.expectedDailyEligibleEntities * armAt(args.trafficSplit, index);
    maxDays = Math.max(maxDays, armAt(args.nPerArm, index) / dailyShare);
  }
  return Math.ceil(maxDays);
}
