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
 * On the known-harmful fixture (true relative lift −20%, margin −10%), the
 * true contrast δ = T − 0.9 C is negative. Declaring safe (lower > 0) is a
 * false-safety error. Proposition B.1 controls that rate at alpha under
 * continuous monitoring, so the ever-safe rate across the look schedule must
 * stay within the predeclared Monte Carlo tolerance of alpha.
 */
describe("one-sided guardrail false-safety simulation", () => {
  const mode = process.env.SPLITCH_STATS_SIMULATION_MODE === "audit" ? "audit" : "smoke";
  const seed = process.env.SPLITCH_STATS_SIMULATION_SEED ?? "424242";
  const requested = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "40", 10);
  const iterations = mode === "audit" ? requested : Math.min(requested, 40);
  const lookSchedule = mode === "audit" ? FIELLER_AUDIT_LOOKS : FIELLER_SMOKE_LOOKS;
  const target_n = Math.max(...lookSchedule);
  const tolerance = monteCarloTolerance(GUARDRAIL_ALPHA, iterations);

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
});

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
