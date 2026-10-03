import { alwaysValidCriticalScale } from "./always-valid-inflation";
import type { ExperimentPlanIssue } from "./experiment-plan-types";
import { normalCdf, normalSurvival } from "./normal-distribution";
import { normalMixtureScale, rhoSquaredForTargetN } from "./sequential-ci";

/** Hard cap on searchable Control-arm n. Beyond this the plan is unrepresentable. */
const MAX_CONTROL_N = 1e12;
const MAX_BINARY_SEARCH_ITERS = 64;

type SizedArms = {
  nPerArm: number[];
  comparisonPowers: number[];
  targetN: number;
};

export type SizedArmsOutcome =
  | { ok: true; sized: SizedArms }
  | { ok: false; issues: readonly ExperimentPlanIssue[] };

export type FixedSizeMde = SizedArms & { mdeAbsolute: number };

export type FixedSizeMdeOutcome =
  | { ok: true; solved: FixedSizeMde; varianceControl: number; varianceTreatment: number }
  | { ok: false; issues: readonly ExperimentPlanIssue[] };

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

function comparisonPowersForPlan(args: {
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

function oversizedControlIssue(path: readonly string[]): ExperimentPlanIssue {
  return {
    path,
    message: `Required Control-arm sample size exceeds the searchable maximum (${MAX_CONTROL_N}).`,
  };
}

/**
 * Size so every Control-vs-treatment comparison reaches `power` under one shared
 * targetN (Control + primary treatment). The mixture boundary at each
 * comparison's own n_c+n_t is used; the binding comparison sets the scale.
 */
export function sizeAlwaysValidArms(args: {
  split: readonly number[];
  alpha: number;
  power: number;
  zBeta: number;
  mdeAbsolute: number;
  varianceControl: number;
  varianceTreatment: number;
}): SizedArmsOutcome {
  const seed = fixedHorizonControlN({
    split: args.split,
    critical: alwaysValidCriticalScale(args.alpha),
    zBeta: args.zBeta,
    mdeAbsolute: args.mdeAbsolute,
    varianceControl: args.varianceControl,
    varianceTreatment: args.varianceTreatment,
  });
  if (!(Number.isFinite(seed) && seed <= MAX_CONTROL_N)) {
    return { ok: false, issues: [oversizedControlIssue(["mdeAbsolute"])] };
  }

  const meets = (controlN: number): boolean =>
    planMeetsPower({ ...args, controlN, powerFloor: args.power });

  const bound = expandControlBound(Math.max(2, Math.ceil(seed)), meets);
  if (!bound.ok) return bound;
  const controlN = binarySearchControlN(bound.low, bound.high, meets);
  const nPerArm = armsFromControl(controlN, args.split);
  const targetN = armAt(nPerArm, 0) + armAt(nPerArm, 1);
  return {
    ok: true,
    sized: {
      nPerArm,
      targetN,
      comparisonPowers: comparisonPowersForPlan({
        nPerArm,
        targetN,
        alpha: args.alpha,
        varianceControl: args.varianceControl,
        varianceTreatment: args.varianceTreatment,
        effectAbsolute: args.mdeAbsolute,
      }),
    },
  };
}

function planMeetsPower(args: {
  split: readonly number[];
  alpha: number;
  powerFloor: number;
  mdeAbsolute: number;
  varianceControl: number;
  varianceTreatment: number;
  controlN: number;
}): boolean {
  const nPerArm = armsFromControl(args.controlN, args.split);
  const targetN = armAt(nPerArm, 0) + armAt(nPerArm, 1);
  return comparisonPowersForPlan({
    nPerArm,
    targetN,
    alpha: args.alpha,
    varianceControl: args.varianceControl,
    varianceTreatment: args.varianceTreatment,
    effectAbsolute: args.mdeAbsolute,
  }).every((achieved) => achieved >= args.powerFloor);
}

function expandControlBound(
  seedHigh: number,
  meets: (controlN: number) => boolean,
): { ok: true; low: number; high: number } | { ok: false; issues: readonly ExperimentPlanIssue[] } {
  let high = seedHigh;
  let low = 1;
  let expandIters = 0;
  while (!meets(high) && high < MAX_CONTROL_N) {
    expandIters += 1;
    if (expandIters > MAX_BINARY_SEARCH_ITERS) {
      return { ok: false, issues: [oversizedControlIssue(["mdeAbsolute"])] };
    }
    low = high;
    const doubled = high * 2;
    high = doubled >= MAX_CONTROL_N ? MAX_CONTROL_N : doubled;
  }
  if (!meets(high)) {
    return { ok: false, issues: [oversizedControlIssue(["mdeAbsolute"])] };
  }
  return { ok: true, low, high };
}

function binarySearchControlN(
  lowStart: number,
  highStart: number,
  meets: (controlN: number) => boolean,
): number {
  let low = lowStart;
  let high = highStart;
  let searchIters = 0;
  while (high - low > 1) {
    searchIters += 1;
    if (searchIters > MAX_BINARY_SEARCH_ITERS) {
      throw new Error("experiment plan sizing binary search failed to terminate");
    }
    const mid = low + Math.floor((high - low) / 2);
    if (meets(mid)) high = mid;
    else low = mid;
  }
  return high;
}

export function fixedHorizonControlN(args: {
  split: readonly number[];
  critical: number;
  zBeta: number;
  mdeAbsolute: number;
  varianceControl: number;
  varianceTreatment: number;
}): number {
  const controlShare = armAt(args.split, 0);
  let maxTotalN = 0;
  for (let index = 1; index < args.split.length; index += 1) {
    const treatmentShare = armAt(args.split, index);
    const factor = args.varianceControl / controlShare + args.varianceTreatment / treatmentShare;
    maxTotalN = Math.max(
      maxTotalN,
      (factor * (args.critical + args.zBeta) ** 2) / args.mdeAbsolute ** 2,
    );
  }
  if (!Number.isFinite(maxTotalN)) return Number.POSITIVE_INFINITY;
  return Math.ceil(maxTotalN * controlShare);
}

export function mdeAtFixedSize(args: {
  split: readonly number[];
  alpha: number;
  zBeta: number;
  fixedSampleSizePerArm: number;
  varianceControl: number;
  varianceTreatment: number;
}): FixedSizeMde {
  const nPerArm = armsFromControl(args.fixedSampleSizePerArm, args.split);
  const targetN = armAt(nPerArm, 0) + armAt(nPerArm, 1);
  const nControl = armAt(nPerArm, 0);
  let mdeAbsolute = 0;
  for (let index = 1; index < nPerArm.length; index += 1) {
    const nTreatment = armAt(nPerArm, index);
    const se = Math.sqrt(args.varianceControl / nControl + args.varianceTreatment / nTreatment);
    const scale = normalMixtureScale(
      nControl + nTreatment,
      args.alpha,
      rhoSquaredForTargetN(args.alpha, targetN),
    );
    mdeAbsolute = Math.max(mdeAbsolute, se * (scale + args.zBeta));
  }
  return {
    mdeAbsolute,
    nPerArm,
    targetN,
    comparisonPowers: comparisonPowersForPlan({
      nPerArm,
      targetN,
      alpha: args.alpha,
      varianceControl: args.varianceControl,
      varianceTreatment: args.varianceTreatment,
      effectAbsolute: mdeAbsolute,
    }),
  };
}
