import { alwaysValidInflation } from "./always-valid-inflation";
import type {
  ExperimentPlanInput,
  ExperimentPlanOutcome,
  ExperimentPlanResult,
} from "./experiment-plan-types";
import { validatePlanInput } from "./experiment-plan-validate";
import {
  armAt,
  armVariances,
  comparisonPower,
  fixedHorizonControlN,
  mdeAtFixedSize,
  sizeAlwaysValidArms,
} from "./experiment-plan-size";
import { inverseNormalCdf } from "./normal-distribution";

export type {
  ExperimentPlanBaselineSource,
  ExperimentPlanInput,
  ExperimentPlanIssue,
  ExperimentPlanMetricKind,
  ExperimentPlanOutcome,
  ExperimentPlanResult,
} from "./experiment-plan-types";

const DEFAULT_ALPHA = 0.05;
const DEFAULT_POWER = 0.8;

export function planExperiment(input: ExperimentPlanInput): ExperimentPlanOutcome {
  const issues = validatePlanInput(input);
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const alpha = input.alpha ?? DEFAULT_ALPHA;
  const power = input.power ?? DEFAULT_POWER;
  const baseline = resolveBaseline(input);
  const split = resolveTrafficSplit(input.armCount, input.trafficSplit);
  const inflation = alwaysValidInflation(alpha);
  const zBeta = inverseNormalCdf(power);
  const fixedSize = input.fixedSampleSizePerArm;
  const mode = fixedSize !== undefined ? "mde_from_size" : "size_from_mde";

  const mdeAbsolute =
    mode === "size_from_mde" ? resolveMdeAbsolute(input, baseline.mean) : Number.NaN;

  // For mde_from_size, variances under the alternative need the solved MDE. Use
  // baseline variance on both arms for the continuous path; binomial fixed-size
  // MDE uses baseline rate variance for both arms as a planning approximation
  // (alternative rate is unknown until MDE is known; iterate once below).
  const seedVariances = armVariances({
    metricKind: input.metricKind,
    baselineVariance: baseline.variance,
    baselineMean: baseline.mean,
    mdeAbsolute: mode === "size_from_mde" ? mdeAbsolute : 0,
  });

  if (mode === "mde_from_size") {
    return planFromFixedSize({
      input,
      baseline,
      split,
      alpha,
      power,
      zBeta,
      inflation,
      fixedSize: fixedSize as number,
      seedVariances,
    });
  }

  const variances = armVariances({
    metricKind: input.metricKind,
    baselineVariance: baseline.variance,
    baselineMean: baseline.mean,
    mdeAbsolute,
  });

  const fixedHorizonNPerArm = fixedHorizonControlN({
    split,
    critical: inverseNormalCdf(1 - alpha / 2),
    zBeta,
    mdeAbsolute,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
  });

  // Size so every comparison hits the requested power under the shared targetN
  // (Control + primary treatment), using each comparison's mixture boundary.
  const sized = sizeAlwaysValidArms({
    split,
    alpha,
    power,
    zBeta,
    mdeAbsolute,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
  });

  return {
    ok: true,
    plan: buildPlan({
      input,
      baseline,
      alpha,
      power,
      inflation,
      mode,
      mdeAbsolute,
      fixedHorizonNPerArm,
      nPerArm: sized.nPerArm,
      targetN: sized.targetN,
      comparisonPowers: sized.comparisonPowers,
      varianceControl: variances.control,
      varianceTreatment: variances.treatment,
    }),
  };
}

function planFromFixedSize(args: {
  input: ExperimentPlanInput;
  baseline: { mean: number; variance: number };
  split: readonly number[];
  alpha: number;
  power: number;
  zBeta: number;
  inflation: number;
  fixedSize: number;
  seedVariances: { control: number; treatment: number };
}): ExperimentPlanOutcome {
  let variances = args.seedVariances;
  let solved = mdeAtFixedSize({
    split: args.split,
    alpha: args.alpha,
    zBeta: args.zBeta,
    fixedSampleSizePerArm: args.fixedSize,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
  });

  if (args.input.metricKind === "binomial") {
    // Recompute treatment variance under the solved alternative rate.
    variances = armVariances({
      metricKind: "binomial",
      baselineVariance: args.baseline.variance,
      baselineMean: args.baseline.mean,
      mdeAbsolute: solved.mdeAbsolute,
    });
    const alternativeRate = args.baseline.mean + solved.mdeAbsolute;
    if (!(alternativeRate > 0 && alternativeRate < 1)) {
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
    solved = mdeAtFixedSize({
      split: args.split,
      alpha: args.alpha,
      zBeta: args.zBeta,
      fixedSampleSizePerArm: args.fixedSize,
      varianceControl: variances.control,
      varianceTreatment: variances.treatment,
    });
  }

  const fixedHorizonNPerArm = fixedHorizonControlN({
    split: args.split,
    critical: inverseNormalCdf(1 - args.alpha / 2),
    zBeta: args.zBeta,
    mdeAbsolute: solved.mdeAbsolute,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
  });

  return {
    ok: true,
    plan: buildPlan({
      input: args.input,
      baseline: args.baseline,
      alpha: args.alpha,
      power: args.power,
      inflation: args.inflation,
      mode: "mde_from_size",
      mdeAbsolute: solved.mdeAbsolute,
      fixedHorizonNPerArm,
      nPerArm: solved.nPerArm,
      targetN: solved.targetN,
      comparisonPowers: solved.comparisonPowers,
      varianceControl: variances.control,
      varianceTreatment: variances.treatment,
    }),
  };
}

function buildPlan(args: {
  input: ExperimentPlanInput;
  baseline: { mean: number; variance: number };
  alpha: number;
  power: number;
  inflation: number;
  mode: "size_from_mde" | "mde_from_size";
  mdeAbsolute: number;
  fixedHorizonNPerArm: number;
  nPerArm: readonly number[];
  targetN: number;
  comparisonPowers: readonly number[];
  varianceControl: number;
  varianceTreatment: number;
}): ExperimentPlanResult {
  const totalEntities = args.nPerArm.reduce((sum, n) => sum + n, 0);
  const expectedDurationDays = Math.ceil(totalEntities / args.input.expectedDailyEligibleEntities);
  const mdeRelative =
    args.baseline.mean === 0 ? null : args.mdeAbsolute / Math.abs(args.baseline.mean);

  return {
    fixedHorizonNPerArm: args.fixedHorizonNPerArm,
    alwaysValidInflation: args.inflation,
    nPerArm: args.nPerArm,
    targetN: args.targetN,
    expectedDurationDays,
    mdeAbsolute: args.mdeAbsolute,
    mdeRelative,
    alpha: args.alpha,
    power: args.power,
    comparisonPowers: args.comparisonPowers,
    guardrailPower: computeGuardrailPower({
      input: args.input,
      baseline: args.baseline,
      nPerArm: args.nPerArm,
      targetN: args.targetN,
      alpha: args.alpha,
      varianceControl: args.varianceControl,
      varianceTreatment: args.varianceTreatment,
    }),
    baselineMean: args.baseline.mean,
    baselineVariance: args.baseline.variance,
    // History lookup is not wired in this slice; callers must supply baselines.
    baselineSource: "caller",
    mode: args.mode,
  };
}

function resolveBaseline(input: ExperimentPlanInput): { mean: number; variance: number } {
  if (input.metricKind === "binomial") {
    const rate = input.baselineRate as number;
    return { mean: rate, variance: rate * (1 - rate) };
  }
  return { mean: input.baselineMean as number, variance: input.baselineVariance as number };
}

function resolveTrafficSplit(armCount: number, split: readonly number[] | undefined): number[] {
  if (split) return [...split];
  return Array.from({ length: armCount }, () => 1 / armCount);
}

function resolveMdeAbsolute(input: ExperimentPlanInput, baselineMean: number): number {
  if (input.mdeAbsolute !== undefined) return input.mdeAbsolute;
  return (input.mdeRelative as number) * Math.abs(baselineMean);
}

function computeGuardrailPower(args: {
  input: ExperimentPlanInput;
  baseline: { mean: number; variance: number };
  nPerArm: readonly number[];
  targetN: number;
  alpha: number;
  varianceControl: number;
  varianceTreatment: number;
}): number | null {
  const { input, baseline, nPerArm } = args;
  let breach: number | undefined = input.guardrailBreachAbsolute;
  if (breach === undefined && input.guardrailBreachRelative !== undefined) {
    breach = input.guardrailBreachRelative * Math.abs(baseline.mean);
  }
  if (breach === undefined) return null;

  // Conservative: power against the smallest treatment arm under the shared targetN.
  const nControl = armAt(nPerArm, 0);
  const nTreatment = Math.min(...nPerArm.slice(1));
  return comparisonPower({
    nControl,
    nTreatment,
    targetN: args.targetN,
    alpha: args.alpha,
    varianceControl: args.varianceControl,
    varianceTreatment: args.varianceTreatment,
    effectAbsolute: breach,
  });
}
