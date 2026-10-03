import { alwaysValidCriticalScale, alwaysValidInflation } from "./always-valid-inflation";
import type {
  ExperimentPlanInput,
  ExperimentPlanOutcome,
  ExperimentPlanResult,
} from "./experiment-plan-types";
import { validatePlanInput } from "./experiment-plan-validate";
import { inverseNormalCdf, normalCdf, normalSurvival } from "./normal-distribution";

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
  const critical = alwaysValidCriticalScale(alpha);
  const zBeta = inverseNormalCdf(power);
  const fixedSize = input.fixedSampleSizePerArm;
  const mode = fixedSize !== undefined ? "mde_from_size" : "size_from_mde";

  const mdeAbsolute =
    mode === "size_from_mde"
      ? resolveMdeAbsolute(input, baseline.mean)
      : mdeAtFixedSize({
          baselineVariance: baseline.variance,
          split,
          critical,
          zBeta,
          fixedSampleSizePerArm: fixedSize as number,
        });

  const fixedHorizonNPerArm = sampleSizePerArmForCritical({
    baselineVariance: baseline.variance,
    split,
    critical: inverseNormalCdf(1 - alpha / 2),
    zBeta,
    mdeAbsolute,
  });

  // Size with the engine mixture critical scale (exact power at the tuned
  // time). Report Schultzberg k* as the reference inflation; realized
  // n_av / n_fh is close but not identical because z_beta is shared.
  const nPerArm =
    mode === "size_from_mde"
      ? sampleSizeArmsForCritical({
          baselineVariance: baseline.variance,
          split,
          critical,
          zBeta,
          mdeAbsolute,
        })
      : nPerArmFromFixed(fixedSize as number, split);

  const controlN = armAt(nPerArm, 0);
  const treatmentN = armAt(nPerArm, 1);
  const totalEntities = nPerArm.reduce((sum, n) => sum + n, 0);
  const expectedDurationDays = Math.ceil(totalEntities / input.expectedDailyEligibleEntities);
  const mdeRelative = baseline.mean === 0 ? null : mdeAbsolute / Math.abs(baseline.mean);

  return {
    ok: true,
    plan: {
      fixedHorizonNPerArm,
      alwaysValidInflation: inflation,
      nPerArm,
      targetN: controlN + treatmentN,
      expectedDurationDays,
      mdeAbsolute,
      mdeRelative,
      alpha,
      power,
      guardrailPower: computeGuardrailPower({ input, baseline, nPerArm, critical }),
      baselineMean: baseline.mean,
      baselineVariance: baseline.variance,
      // History lookup is not wired in this slice; callers must supply baselines.
      baselineSource: "caller",
      mode,
    } satisfies ExperimentPlanResult,
  };
}

function armAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`expected arm index ${index} in a plan with ${values.length} arms`);
  }
  return value;
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

function allocationFactor(split: readonly number[]): number {
  const controlShare = armAt(split, 0);
  let maxFactor = 0;
  for (let index = 1; index < split.length; index += 1) {
    maxFactor = Math.max(maxFactor, 1 / controlShare + 1 / armAt(split, index));
  }
  return maxFactor;
}

function sampleSizePerArmForCritical(args: {
  baselineVariance: number;
  split: readonly number[];
  critical: number;
  zBeta: number;
  mdeAbsolute: number;
}): number {
  const totalN =
    (args.baselineVariance * allocationFactor(args.split) * (args.critical + args.zBeta) ** 2) /
    args.mdeAbsolute ** 2;
  return Math.ceil(totalN * armAt(args.split, 0));
}

function sampleSizeArmsForCritical(args: {
  baselineVariance: number;
  split: readonly number[];
  critical: number;
  zBeta: number;
  mdeAbsolute: number;
}): number[] {
  const controlN = sampleSizePerArmForCritical(args);
  const controlShare = armAt(args.split, 0);
  return args.split.map((share) => Math.ceil(controlN * (share / controlShare)));
}

function nPerArmFromFixed(fixedSampleSizePerArm: number, split: readonly number[]): number[] {
  const controlShare = armAt(split, 0);
  return split.map((share) => Math.ceil(fixedSampleSizePerArm * (share / controlShare)));
}

function mdeAtFixedSize(args: {
  baselineVariance: number;
  split: readonly number[];
  critical: number;
  zBeta: number;
  fixedSampleSizePerArm: number;
}): number {
  const nPerArm = nPerArmFromFixed(args.fixedSampleSizePerArm, args.split);
  const nControl = armAt(nPerArm, 0);
  const nTreatment = Math.min(...nPerArm.slice(1));
  const se = Math.sqrt(args.baselineVariance * (1 / nControl + 1 / nTreatment));
  return se * (args.critical + args.zBeta);
}

function computeGuardrailPower(args: {
  input: ExperimentPlanInput;
  baseline: { mean: number; variance: number };
  nPerArm: readonly number[];
  critical: number;
}): number | null {
  const { input, baseline, nPerArm, critical } = args;
  let breach: number | undefined = input.guardrailBreachAbsolute;
  if (breach === undefined && input.guardrailBreachRelative !== undefined) {
    if (baseline.mean === 0) return null;
    breach = input.guardrailBreachRelative * Math.abs(baseline.mean);
  }
  if (breach === undefined) return null;

  const nControl = armAt(nPerArm, 0);
  const nTreatment = Math.min(...nPerArm.slice(1));
  const se = Math.sqrt(baseline.variance * (1 / nControl + 1 / nTreatment));
  const deltaOverSe = breach / se;
  return normalCdf(-critical - deltaOverSe) + normalSurvival(critical - deltaOverSe);
}
