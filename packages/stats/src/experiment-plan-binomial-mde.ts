import {
  armAt,
  armVariances,
  comparisonPower,
  mdeAtFixedSize,
  type FixedSizeMdeOutcome,
} from "./experiment-plan-size";

const BINOMIAL_MDE_FIXED_POINT_ITERS = 32;
const BINOMIAL_MDE_REL_TOL = 1e-12;

/**
 * Solve fixed-size binomial MDE jointly with alternative-rate treatment variance.
 * Iterate to a fixed point, then recompute power from the final MDE and variances.
 */
export function solveBinomialMdeAtFixedSize(args: {
  baselineRate: number;
  baselineVariance: number;
  split: readonly number[];
  alpha: number;
  zBeta: number;
  fixedSampleSizePerArm: number;
}): FixedSizeMdeOutcome {
  let mdeAbsolute = 0;
  let variances = armVariances({
    metricKind: "binomial",
    baselineVariance: args.baselineVariance,
    baselineMean: args.baselineRate,
    mdeAbsolute: 0,
  });

  for (let iter = 0; iter < BINOMIAL_MDE_FIXED_POINT_ITERS; iter += 1) {
    const solved = mdeAtFixedSize({
      split: args.split,
      alpha: args.alpha,
      zBeta: args.zBeta,
      fixedSampleSizePerArm: args.fixedSampleSizePerArm,
      varianceControl: variances.control,
      varianceTreatment: variances.treatment,
    });
    const rateIssue = alternativeRateIssue(args.baselineRate, solved.mdeAbsolute);
    if (rateIssue) return { ok: false, issues: [rateIssue] };

    variances = armVariances({
      metricKind: "binomial",
      baselineVariance: args.baselineVariance,
      baselineMean: args.baselineRate,
      mdeAbsolute: solved.mdeAbsolute,
    });
    const converged =
      mdeAbsolute > 0 &&
      Math.abs(solved.mdeAbsolute - mdeAbsolute) <=
        BINOMIAL_MDE_REL_TOL * Math.max(solved.mdeAbsolute, mdeAbsolute);
    mdeAbsolute = solved.mdeAbsolute;
    if (converged) break;
  }

  const rateIssue = alternativeRateIssue(args.baselineRate, mdeAbsolute);
  if (rateIssue) return { ok: false, issues: [rateIssue] };

  const nPerArm = args.split.map((share) =>
    Math.ceil(args.fixedSampleSizePerArm * (share / armAt(args.split, 0))),
  );
  const targetN = armAt(nPerArm, 0) + armAt(nPerArm, 1);
  const nControl = armAt(nPerArm, 0);
  const powers = [];
  for (let index = 1; index < nPerArm.length; index += 1) {
    powers.push(
      comparisonPower({
        nControl,
        nTreatment: armAt(nPerArm, index),
        targetN,
        alpha: args.alpha,
        varianceControl: variances.control,
        varianceTreatment: variances.treatment,
        effectAbsolute: mdeAbsolute,
      }),
    );
  }

  return {
    ok: true,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
    solved: { mdeAbsolute, nPerArm, targetN, comparisonPowers: powers },
  };
}

function alternativeRateIssue(
  baselineRate: number,
  mdeAbsolute: number,
): { path: readonly string[]; message: string } | null {
  const alternativeRate = baselineRate + mdeAbsolute;
  if (alternativeRate > 0 && alternativeRate < 1) return null;
  return {
    path: ["fixedSampleSizePerArm"],
    message: "Solved alternative rate (baselineRate + MDE) must be in (0, 1) at this sample size.",
  };
}
