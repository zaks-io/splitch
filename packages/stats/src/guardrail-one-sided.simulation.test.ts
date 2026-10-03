import { describe, expect, it } from "vitest";
import { evaluateOneSidedGuardrail, type GuardrailVerdict } from "./guardrail-one-sided";
import { FIELLER_AUDIT_LOOKS, FIELLER_SMOKE_LOOKS } from "./relative-ci-simulation";
import {
  FIELLER_CONTROL,
  FIELLER_METRIC_ID,
  FIELLER_RUN_ID,
  FIELLER_TREATMENT,
  drawRelativeExperiment,
  gaussianFromUniform,
  guardrailSpec,
  lookAtRelative,
  seededUniform,
  type RelativeExperimentDraw,
} from "./relative-ci-simulation-draws";
import { monteCarloTolerance } from "./sequential-ci-simulation";
import { estimateMetricComparison } from "./variance-estimators";

const GUARDRAIL_ALPHA = 0.05;
const GUARDRAIL_THRESHOLD_PCT = -10;
const GUARDRAIL_MARGIN = GUARDRAIL_THRESHOLD_PCT / 100;

/**
 * analysis-v2 one-sided Guardrail false-safety proof (plan 0.8 / C4).
 *
 * Union-bound design: Control sign at α/2 (two-sided) + oriented contrast at
 * α/2 (one-sided) jointly controls false-safety at alpha. On the known-harmful
 * fixture (true relative lift −20%, margin −10%), declaring safe (lower > 0)
 * is a false-safety error; the ever-safe rate across the look schedule must
 * stay within the predeclared Monte Carlo tolerance of alpha.
 *
 * Codex validity regressions (fixed-horizon Gaussian draws of arm means):
 * 1. Near-zero Control with margin below −100% must not inflate false-safety
 *    by picking orientation from the noisy Control estimate alone.
 * 2. The procedure reports no contrast-derived relative lower bound; Fieller
 *    stays the reporting interval. Contrast L covers true δ* within α/2 when
 *    Control sign is correctly established.
 */
describe("one-sided guardrail false-safety simulation", () => {
  const mode = process.env.SPLITCH_STATS_SIMULATION_MODE === "audit" ? "audit" : "smoke";
  const seed = process.env.SPLITCH_STATS_SIMULATION_SEED ?? "424242";
  const requested = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "40", 10);
  const iterations = mode === "audit" ? requested : Math.min(requested, 40);
  const lookSchedule = mode === "audit" ? FIELLER_AUDIT_LOOKS : FIELLER_SMOKE_LOOKS;
  const target_n = Math.max(...lookSchedule);
  const tolerance = monteCarloTolerance(GUARDRAIL_ALPHA, iterations);
  const gaussianDraws = mode === "audit" ? 200_000 : Math.min(requested, 2_000);

  it("keeps ever-safe rate within alpha on the known-harmful fixture", {
    timeout: 180_000,
  }, () => {
    const rates = runFalseSafety({ seed, iterations, lookSchedule, target_n });
    console.info(
      `One-sided guardrail ${mode} known-harmful seed=${seed} n=${iterations} ` +
        `everSafe=${rates.everSafeRate} lastSafe=${rates.lastLookSafeRate} ` +
        `undetermined=${rates.undeterminedRate} tolerance=${tolerance}`,
    );

    expect(rates.undeterminedRate).toBeLessThan(0.05);
    expect(rates.everSafeRate).toBeLessThanOrEqual(GUARDRAIL_ALPHA + tolerance);
    expect(rates.lastLookSafeRate).toBeLessThanOrEqual(GUARDRAIL_ALPHA + tolerance);
  });

  it("keeps false-safe rate within alpha on Codex near-zero Control / margin < -100%", {
    timeout: 180_000,
  }, () => {
    // Codex finding #1: margin −200%, true C 0.001, T −0.002, Var(C)=1, Var(T)=1e-6.
    // True δ_raw = T − (1−2)C = T + C = −0.001 < 0; with positive C, δ* < 0.
    const drawTolerance = monteCarloTolerance(GUARDRAIL_ALPHA, gaussianDraws);
    const falseSafeRate = runGaussianFalseSafety({
      seed: `${seed}:codex-near-zero-control`,
      iterations: gaussianDraws,
      trueControl: 0.001,
      trueTreatment: -0.002,
      controlVar: 1,
      treatmentVar: 1e-6,
      margin: -2,
    });
    console.info(
      `One-sided guardrail ${mode} Codex near-zero Control seed=${seed} n=${gaussianDraws} ` +
        `falseSafe=${falseSafeRate} tolerance=${drawTolerance}`,
    );
    expect(falseSafeRate).toBeLessThanOrEqual(GUARDRAIL_ALPHA + drawTolerance);
  });

  it("does not emit a contrast-derived relative lower bound (Codex relative-scale case)", {
    timeout: 180_000,
  }, () => {
    // Codex finding #2: true C=10, T=20 (relative lift +100%), Vars 1 and 0.01,
    // margin −10%. The old margin + L/|Ĉ| relative lower exceeded true lift in
    // ~23% of draws. The union-bound path reports no such quantity.
    const coverage = runContrastLowerCoverage({
      seed: `${seed}:codex-relative-scale`,
      iterations: gaussianDraws,
      trueControl: 10,
      trueTreatment: 20,
      controlVar: 1,
      treatmentVar: 0.01,
      margin: -0.1,
    });
    const alphaHalf = GUARDRAIL_ALPHA / 2;
    const coverTolerance = monteCarloTolerance(alphaHalf, gaussianDraws);
    console.info(
      `One-sided guardrail ${mode} Codex relative-scale seed=${seed} n=${gaussianDraws} ` +
        `signEstablished=${coverage.signEstablished} contrastMissRate=${coverage.missRate} ` +
        `tolerance=${coverTolerance}`,
    );
    expect(coverage.signEstablished).toBeGreaterThan(gaussianDraws * 0.5);
    expect(coverage.missRate).toBeLessThanOrEqual(alphaHalf + coverTolerance);
  });

  it("stays undecided (not false-safe) for near-zero Control with margin below -100%", () => {
    // Deterministic regression: noisy near-zero Control must not establish sign
    // and must not declare safe under a deeply negative margin.
    const result = evaluateOneSidedGuardrail({
      treatmentEstimate: -0.002,
      controlEstimate: 0.001,
      treatmentVar: 1e-6,
      controlVar: 1,
      margin: -2,
      alpha: GUARDRAIL_ALPHA,
      n_t: 500,
      n_c: 500,
      target_n: 1_000,
      horizon: "fixed",
    });
    expect(result.controlSignEstablished).toBe(false);
    expect(result.verdict).toBe("undecided");
  });
});

function runContrastLowerCoverage(args: {
  readonly seed: string;
  readonly iterations: number;
  readonly trueControl: number;
  readonly trueTreatment: number;
  readonly controlVar: number;
  readonly treatmentVar: number;
  readonly margin: number;
}): { signEstablished: number; missRate: number } {
  const trueContrast = args.trueTreatment - (1 + args.margin) * args.trueControl;
  const uniform = seededUniform(args.seed);
  const gaussian = gaussianFromUniform(uniform);
  let signEstablished = 0;
  let contrastMisses = 0;

  for (let i = 0; i < args.iterations; i += 1) {
    const draw = drawArmMeans(args, gaussian);
    if (draw === null) continue;
    const result = evaluateFixedGuardrail(draw, args);
    expect(result).not.toHaveProperty("relativeLowerPct");
    if (!result.controlSignEstablished) continue;
    // Wrong-sign establishment is charged to the α/2 Control piece.
    if (Math.sign(draw.controlEstimate) !== Math.sign(args.trueControl)) continue;
    signEstablished += 1;
    if (result.lower > trueContrast) contrastMisses += 1;
  }

  return {
    signEstablished,
    missRate: signEstablished === 0 ? 0 : contrastMisses / signEstablished,
  };
}

function runGaussianFalseSafety(args: {
  readonly seed: string;
  readonly iterations: number;
  readonly trueControl: number;
  readonly trueTreatment: number;
  readonly controlVar: number;
  readonly treatmentVar: number;
  readonly margin: number;
}): number {
  const uniform = seededUniform(args.seed);
  const gaussian = gaussianFromUniform(uniform);
  let falseSafe = 0;

  for (let i = 0; i < args.iterations; i += 1) {
    const draw = drawArmMeans(args, gaussian);
    if (draw === null) continue;
    if (evaluateFixedGuardrail(draw, args).verdict === "safe") falseSafe += 1;
  }

  return falseSafe / args.iterations;
}

function drawArmMeans(
  args: {
    readonly trueControl: number;
    readonly trueTreatment: number;
    readonly controlVar: number;
    readonly treatmentVar: number;
  },
  gaussian: () => number,
): { controlEstimate: number; treatmentEstimate: number } | null {
  const controlEstimate = args.trueControl + Math.sqrt(args.controlVar) * gaussian();
  const treatmentEstimate = args.trueTreatment + Math.sqrt(args.treatmentVar) * gaussian();
  if (controlEstimate === 0) return null;
  return { controlEstimate, treatmentEstimate };
}

function evaluateFixedGuardrail(
  draw: { readonly controlEstimate: number; readonly treatmentEstimate: number },
  args: {
    readonly controlVar: number;
    readonly treatmentVar: number;
    readonly margin: number;
  },
) {
  return evaluateOneSidedGuardrail({
    treatmentEstimate: draw.treatmentEstimate,
    controlEstimate: draw.controlEstimate,
    treatmentVar: args.treatmentVar,
    controlVar: args.controlVar,
    margin: args.margin,
    alpha: GUARDRAIL_ALPHA,
    n_t: 500,
    n_c: 500,
    target_n: 1_000,
    horizon: "fixed",
  });
}

function runFalseSafety(args: {
  readonly seed: string;
  readonly iterations: number;
  readonly lookSchedule: readonly number[];
  readonly target_n: number;
}): { everSafeRate: number; lastLookSafeRate: number; undeterminedRate: number } {
  const spec = guardrailSpec("known-harmful");
  let everSafe = 0;
  let lastLookSafe = 0;
  let undetermined = 0;
  const lastLook = args.lookSchedule[args.lookSchedule.length - 1];

  for (let iteration = 0; iteration < args.iterations; iteration += 1) {
    const trial = oneHarmfulTrial({
      seed: `${args.seed}:one-sided-guardrail:known-harmful:${iteration}`,
      spec,
      lookSchedule: args.lookSchedule,
      target_n: args.target_n,
      lastLook,
    });
    if (trial.undetermined) undetermined += 1;
    if (trial.everSafe) everSafe += 1;
    if (trial.lastLookSafe) lastLookSafe += 1;
  }

  return {
    everSafeRate: everSafe / args.iterations,
    lastLookSafeRate: lastLookSafe / args.iterations,
    undeterminedRate: undetermined / args.iterations,
  };
}

function oneHarmfulTrial(args: {
  readonly seed: string;
  readonly spec: ReturnType<typeof guardrailSpec>;
  readonly lookSchedule: readonly number[];
  readonly target_n: number;
  readonly lastLook: number | undefined;
}): { everSafe: boolean; lastLookSafe: boolean; undetermined: boolean } {
  const uniform = seededUniform(args.seed);
  const draw = drawRelativeExperiment(
    uniform,
    gaussianFromUniform(uniform),
    args.spec,
    args.target_n,
  );
  let everSafe = false;
  let lastLookSafe = false;
  let sawVerdict = false;

  for (const look of args.lookSchedule) {
    const verdict = lookVerdict(draw, look, args.target_n);
    if (verdict === null) continue;
    sawVerdict = true;
    if (verdict !== "safe") continue;
    everSafe = true;
    if (look === args.lastLook) lastLookSafe = true;
  }

  return { everSafe, lastLookSafe, undetermined: !sawVerdict };
}

function lookVerdict(
  draw: RelativeExperimentDraw,
  look: number,
  target_n: number,
): GuardrailVerdict | null {
  const rows = lookAtRelative(draw, look);
  const comparison = estimateMetricComparison({
    run_id: FIELLER_RUN_ID,
    metric_id: FIELLER_METRIC_ID,
    metric_type: "count",
    control_variant: FIELLER_CONTROL,
    treatment_variant: FIELLER_TREATMENT,
    exposures: rows.exposures,
    metric_values: rows.metricValues,
    pre_period_covariates: rows.covariates,
    cuped: true,
    winsorize: false,
  });
  const components = comparison.absolute_lift_var_components;
  if (
    components === null ||
    comparison.treatment.point_estimate === null ||
    comparison.control.point_estimate === null ||
    comparison.control.point_estimate === 0
  ) {
    return null;
  }

  return evaluateOneSidedGuardrail({
    treatmentEstimate: comparison.treatment.point_estimate,
    controlEstimate: comparison.control.point_estimate,
    treatmentVar: components.treatment,
    controlVar: components.control,
    margin: GUARDRAIL_MARGIN,
    alpha: GUARDRAIL_ALPHA,
    n_t: comparison.treatment.sample_size_n,
    n_c: comparison.control.sample_size_n,
    target_n,
    horizon: "sequential",
  }).verdict;
}
