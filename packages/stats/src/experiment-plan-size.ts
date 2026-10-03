import { alwaysValidCriticalScale } from "./always-valid-inflation";
import type { ExperimentPlanIssue } from "./experiment-plan-types";
import { armAt, comparisonPowersForPlan, representableArmCounts } from "./experiment-plan-power";
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

type FixedSizeMde = SizedArms & { mdeAbsolute: number };

export type FixedSizeMdeSolve =
  | { ok: true; solved: FixedSizeMde }
  | { ok: false; issues: readonly ExperimentPlanIssue[] };

export type FixedSizeMdeOutcome =
  | { ok: true; solved: FixedSizeMde; varianceControl: number; varianceTreatment: number }
  | { ok: false; issues: readonly ExperimentPlanIssue[] };

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
  const counts = representableArmCounts(controlN, args.split, ["mdeAbsolute"]);
  if (!counts.ok) return counts;
  return {
    ok: true,
    sized: {
      nPerArm: counts.nPerArm,
      targetN: counts.targetN,
      comparisonPowers: comparisonPowersForPlan({
        nPerArm: counts.nPerArm,
        targetN: counts.targetN,
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
  const counts = representableArmCounts(args.controlN, args.split, ["mdeAbsolute"]);
  if (!counts.ok) return false;
  return comparisonPowersForPlan({
    nPerArm: counts.nPerArm,
    targetN: counts.targetN,
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
}): FixedSizeMdeSolve {
  const counts = representableArmCounts(args.fixedSampleSizePerArm, args.split, [
    "fixedSampleSizePerArm",
  ]);
  if (!counts.ok) return counts;
  const { nPerArm, targetN } = counts;
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
    ok: true,
    solved: {
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
    },
  };
}
