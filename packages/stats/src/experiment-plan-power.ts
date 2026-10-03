import type { ExperimentPlanIssue } from "./experiment-plan-types";
import { normalCdf, normalSurvival } from "./normal-distribution";
import { normalMixtureScale, rhoSquaredForTargetN } from "./sequential-ci";

/** Same ceiling the response contract enforces via Zod `.int()` (safe integers). */
export const EXPERIMENT_PLAN_MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

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
