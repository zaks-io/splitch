import type { ExperimentPlanInput } from "./experiment-plan-types";
import { armVariances, minComparisonPower } from "./experiment-plan-power";

/**
 * Power to detect a stated guardrail breach under the shared plan sizes.
 * Continuous variance is direction-invariant. Binomial breach has no declared
 * direction, so each feasible signed alternative is evaluated and the minimum
 * (worst-case) power is returned.
 */
export function computeGuardrailPower(args: {
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

  if (input.metricKind !== "binomial") {
    const breachVariances = armVariances({
      metricKind: input.metricKind,
      baselineVariance: baseline.variance,
      baselineMean: baseline.mean,
      mdeAbsolute: breach,
    });
    return minComparisonPower({
      nPerArm,
      targetN: args.targetN,
      alpha: args.alpha,
      varianceControl: args.varianceControl,
      varianceTreatment: breachVariances.treatment,
      effectAbsolute: breach,
    });
  }

  return minFeasibleBinomialBreachPower({
    baselineMean: baseline.mean,
    baselineVariance: baseline.variance,
    breach,
    nPerArm,
    targetN: args.targetN,
    alpha: args.alpha,
    varianceControl: args.varianceControl,
  });
}

function minFeasibleBinomialBreachPower(args: {
  baselineMean: number;
  baselineVariance: number;
  breach: number;
  nPerArm: readonly number[];
  targetN: number;
  alpha: number;
  varianceControl: number;
}): number | null {
  const powers: number[] = [];
  for (const signed of [args.breach, -args.breach]) {
    const alternativeRate = args.baselineMean + signed;
    if (!(alternativeRate > 0 && alternativeRate < 1)) continue;
    const breachVariances = armVariances({
      metricKind: "binomial",
      baselineVariance: args.baselineVariance,
      baselineMean: args.baselineMean,
      mdeAbsolute: signed,
    });
    powers.push(
      minComparisonPower({
        nPerArm: args.nPerArm,
        targetN: args.targetN,
        alpha: args.alpha,
        varianceControl: args.varianceControl,
        varianceTreatment: breachVariances.treatment,
        effectAbsolute: args.breach,
      }),
    );
  }
  // Validation should have refused when neither direction is feasible.
  if (powers.length === 0) return null;
  return Math.min(...powers);
}
