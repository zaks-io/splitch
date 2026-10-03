import { alwaysValidInflation } from "./always-valid-inflation";
import { solveBinomialMdeAtFixedSize } from "./experiment-plan-binomial-mde";
import type {
  ExperimentPlanInput,
  ExperimentPlanOutcome,
  ExperimentPlanResult,
} from "./experiment-plan-types";
import { validatePlanInput } from "./experiment-plan-validate";
import {
  armVariances,
  EXPERIMENT_PLAN_MAX_SAFE_COUNT,
  minComparisonPower,
} from "./experiment-plan-power";
import { fixedHorizonControlN, mdeAtFixedSize, sizeAlwaysValidArms } from "./experiment-plan-size";
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
    });
  }

  const mdeAbsolute = resolveMdeAbsolute(input, baseline.mean);
  const variances = armVariances({
    metricKind: input.metricKind,
    baselineVariance: baseline.variance,
    baselineMean: baseline.mean,
    mdeAbsolute,
  });

  const sized = sizeAlwaysValidArms({
    split,
    alpha,
    power,
    zBeta,
    mdeAbsolute,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
  });
  if (!sized.ok) return sized;

  const fixedHorizonNPerArm = fixedHorizonControlN({
    split,
    critical: inverseNormalCdf(1 - alpha / 2),
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
      nPerArm: sized.sized.nPerArm,
      targetN: sized.sized.targetN,
      comparisonPowers: sized.sized.comparisonPowers,
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
}): ExperimentPlanOutcome {
  if (args.input.metricKind === "binomial") {
    const joint = solveBinomialMdeAtFixedSize({
      baselineRate: args.baseline.mean,
      baselineVariance: args.baseline.variance,
      split: args.split,
      alpha: args.alpha,
      zBeta: args.zBeta,
      fixedSampleSizePerArm: args.fixedSize,
    });
    if (!joint.ok) return joint;
    return finishFixedSizePlan({
      ...args,
      solved: joint.solved,
      varianceControl: joint.varianceControl,
      varianceTreatment: joint.varianceTreatment,
    });
  }
  const variances = armVariances({
    metricKind: "continuous",
    baselineVariance: args.baseline.variance,
    baselineMean: args.baseline.mean,
    mdeAbsolute: 0,
  });
  const solved = mdeAtFixedSize({
    split: args.split,
    alpha: args.alpha,
    zBeta: args.zBeta,
    fixedSampleSizePerArm: args.fixedSize,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
  });
  if (!solved.ok) return solved;
  return finishFixedSizePlan({
    ...args,
    solved: solved.solved,
    varianceControl: variances.control,
    varianceTreatment: variances.treatment,
  });
}

function finishFixedSizePlan(args: {
  input: ExperimentPlanInput;
  baseline: { mean: number; variance: number };
  split: readonly number[];
  alpha: number;
  power: number;
  zBeta: number;
  inflation: number;
  solved: {
    mdeAbsolute: number;
    nPerArm: readonly number[];
    targetN: number;
    comparisonPowers: readonly number[];
  };
  varianceControl: number;
  varianceTreatment: number;
}): ExperimentPlanOutcome {
  const fixedHorizonNPerArm = fixedHorizonControlN({
    split: args.split,
    critical: inverseNormalCdf(1 - args.alpha / 2),
    zBeta: args.zBeta,
    mdeAbsolute: args.solved.mdeAbsolute,
    varianceControl: args.varianceControl,
    varianceTreatment: args.varianceTreatment,
  });
  if (!Number.isSafeInteger(fixedHorizonNPerArm) || fixedHorizonNPerArm < 1) {
    return {
      ok: false,
      issues: [
        {
          path: ["fixedSampleSizePerArm"],
          message: `Derived arm sample size or targetN exceeds the representable maximum (${EXPERIMENT_PLAN_MAX_SAFE_COUNT}).`,
        },
      ],
    };
  }

  return {
    ok: true,
    plan: buildPlan({
      input: args.input,
      baseline: args.baseline,
      alpha: args.alpha,
      power: args.power,
      inflation: args.inflation,
      mode: "mde_from_size",
      mdeAbsolute: args.solved.mdeAbsolute,
      fixedHorizonNPerArm,
      nPerArm: args.solved.nPerArm,
      targetN: args.solved.targetN,
      comparisonPowers: args.solved.comparisonPowers,
      varianceControl: args.varianceControl,
      varianceTreatment: args.varianceTreatment,
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
}): number | null {
  const { input, baseline, nPerArm } = args;
  let breach: number | undefined = input.guardrailBreachAbsolute;
  if (breach === undefined && input.guardrailBreachRelative !== undefined) {
    breach = input.guardrailBreachRelative * Math.abs(baseline.mean);
  }
  if (breach === undefined) return null;
  // Variance under the breach alternative, not the goal MDE.
  const breachVariances = armVariances({
    metricKind: input.metricKind,
    baselineVariance: baseline.variance,
    baselineMean: baseline.mean,
    mdeAbsolute: breach,
  });
  // Shared targetN makes each comparison's mixture boundary depend on its own
  // n_c+n_t; the worst-case (minimum) power is not always the smallest arm.
  return minComparisonPower({
    nPerArm,
    targetN: args.targetN,
    alpha: args.alpha,
    varianceControl: args.varianceControl,
    varianceTreatment: breachVariances.treatment,
    effectAbsolute: breach,
  });
}
