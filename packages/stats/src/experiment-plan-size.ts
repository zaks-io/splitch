import { alwaysValidCriticalScale } from "./always-valid-inflation";
import { normalCdf, normalSurvival } from "./normal-distribution";
import { normalMixtureScale, rhoSquaredForTargetN } from "./sequential-ci";

const MAX_CONTROL_N = 1e12;

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
}): { nPerArm: number[]; comparisonPowers: number[]; targetN: number } {
  const meets = (controlN: number): boolean => {
    const nPerArm = armsFromControl(controlN, args.split);
    const targetN = armAt(nPerArm, 0) + armAt(nPerArm, 1);
    return comparisonPowersForPlan({
      nPerArm,
      targetN,
      alpha: args.alpha,
      varianceControl: args.varianceControl,
      varianceTreatment: args.varianceTreatment,
      effectAbsolute: args.mdeAbsolute,
    }).every((achieved) => achieved >= args.power);
  };

  let high = Math.max(
    2,
    fixedHorizonControlN({
      split: args.split,
      critical: alwaysValidCriticalScale(args.alpha),
      zBeta: args.zBeta,
      mdeAbsolute: args.mdeAbsolute,
      varianceControl: args.varianceControl,
      varianceTreatment: args.varianceTreatment,
    }),
  );
  let low = 1;
  while (!meets(high) && high < MAX_CONTROL_N) {
    low = high;
    high = Math.min(MAX_CONTROL_N, high * 2);
  }
  if (!meets(high)) {
    throw new Error("experiment plan sizing exceeded the maximum searchable Control n");
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (meets(mid)) high = mid;
    else low = mid;
  }

  const nPerArm = armsFromControl(high, args.split);
  const targetN = armAt(nPerArm, 0) + armAt(nPerArm, 1);
  return {
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
  };
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
  return Math.ceil(maxTotalN * controlShare);
}

export function mdeAtFixedSize(args: {
  split: readonly number[];
  alpha: number;
  zBeta: number;
  fixedSampleSizePerArm: number;
  varianceControl: number;
  varianceTreatment: number;
}): { mdeAbsolute: number; nPerArm: number[]; comparisonPowers: number[]; targetN: number } {
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
