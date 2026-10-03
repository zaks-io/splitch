import type { ExperimentPlanIssue } from "./experiment-plan-types";
import { armVariances, comparisonPowersForPlan } from "./experiment-plan-power";
import { mdeAtFixedSize, type FixedSizeMdeOutcome } from "./experiment-plan-size";

const BINOMIAL_MDE_ROOT_ITERS = 64;
/** Keep treatment rate strictly inside (0, 1); exclude the open endpoint. */
const ADMISSIBLE_MDE_FRAC = 1 - 1e-12;

type BinomialMdeArgs = {
  baselineRate: number;
  baselineVariance: number;
  split: readonly number[];
  alpha: number;
  zBeta: number;
  fixedSampleSizePerArm: number;
};

type ImpliedMde = number | { ok: false; issues: readonly ExperimentPlanIssue[] };

/**
 * Solve fixed-size binomial MDE jointly with alternative-rate treatment variance.
 * Bracketed root search over the admissible MDE interval so intermediate
 * overshoots of the rate boundary do not reject a feasible plan.
 */
export function solveBinomialMdeAtFixedSize(args: BinomialMdeArgs): FixedSizeMdeOutcome {
  const maxAdmissibleMde = (1 - args.baselineRate) * ADMISSIBLE_MDE_FRAC;
  if (!(maxAdmissibleMde > 0)) return impossibleAlternativeRateOutcome();

  const fHi = impliedBinomialMde(args, maxAdmissibleMde);
  if (typeof fHi !== "number") return fHi;
  // No fixed point in (0, 1 - baselineRate): required MDE stays above every
  // admissible candidate (treatment rate would leave (0, 1)).
  if (fHi > maxAdmissibleMde) return impossibleAlternativeRateOutcome();

  const bracket = bracketAdmissibleMde(args, maxAdmissibleMde);
  if (!bracket.ok) return bracket;
  return finishBinomialMde(args, bisectBinomialMdeRoot(args, bracket.lo, bracket.hi));
}

function impliedBinomialMde(args: BinomialMdeArgs, mdeAbsolute: number): ImpliedMde {
  const variances = armVariances({
    metricKind: "binomial",
    baselineVariance: args.baselineVariance,
    baselineMean: args.baselineRate,
    mdeAbsolute,
  });
  const solved = mdeAtFixedSize({
    split: args.split,
    alpha: args.alpha,
    zBeta: args.zBeta,
    fixedSampleSizePerArm: args.fixedSampleSizePerArm,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
  });
  if (!solved.ok) return solved;
  return solved.solved.mdeAbsolute;
}

function bracketAdmissibleMde(
  args: BinomialMdeArgs,
  maxAdmissibleMde: number,
): { ok: true; lo: number; hi: number } | { ok: false; issues: readonly ExperimentPlanIssue[] } {
  let lo = Math.min(maxAdmissibleMde * 1e-6, maxAdmissibleMde / 2);
  const hi = maxAdmissibleMde;
  let fLo = impliedBinomialMde(args, lo);
  if (typeof fLo !== "number") return fLo;
  let expandIters = 0;
  while (fLo < lo && lo > maxAdmissibleMde * 1e-18 && expandIters < BINOMIAL_MDE_ROOT_ITERS) {
    expandIters += 1;
    lo *= 0.5;
    fLo = impliedBinomialMde(args, lo);
    if (typeof fLo !== "number") return fLo;
  }
  // If f(δ) < δ on the whole probe range, the consistent root is at/below the
  // smallest probed candidate — collapse the bracket there.
  if (fLo < lo) return { ok: true, lo, hi: lo };
  return { ok: true, lo, hi };
}

function bisectBinomialMdeRoot(args: BinomialMdeArgs, loStart: number, hiStart: number): number {
  let lo = loStart;
  let hi = hiStart;
  for (let iter = 0; iter < BINOMIAL_MDE_ROOT_ITERS; iter += 1) {
    const mid = 0.5 * (lo + hi);
    const fMid = impliedBinomialMde(args, mid);
    if (typeof fMid !== "number") return mid;
    if (fMid > mid) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function finishBinomialMde(args: BinomialMdeArgs, mdeAbsolute: number): FixedSizeMdeOutcome {
  const rateIssue = alternativeRateIssue(args.baselineRate, mdeAbsolute);
  if (rateIssue) return { ok: false, issues: [rateIssue] };

  const variances = armVariances({
    metricKind: "binomial",
    baselineVariance: args.baselineVariance,
    baselineMean: args.baselineRate,
    mdeAbsolute,
  });
  const sized = mdeAtFixedSize({
    split: args.split,
    alpha: args.alpha,
    zBeta: args.zBeta,
    fixedSampleSizePerArm: args.fixedSampleSizePerArm,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
  });
  if (!sized.ok) return sized;

  return {
    ok: true,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
    solved: {
      mdeAbsolute,
      nPerArm: sized.solved.nPerArm,
      targetN: sized.solved.targetN,
      comparisonPowers: comparisonPowersForPlan({
        nPerArm: sized.solved.nPerArm,
        targetN: sized.solved.targetN,
        alpha: args.alpha,
        varianceControl: variances.control,
        varianceTreatment: variances.treatment,
        effectAbsolute: mdeAbsolute,
      }),
    },
  };
}

function impossibleAlternativeRateOutcome(): FixedSizeMdeOutcome {
  return {
    ok: false,
    issues: [
      {
        path: ["fixedSampleSizePerArm"],
        message:
          "Solved alternative rate (baselineRate + MDE) must be in (0, 1) at this sample size.",
      },
    ],
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
