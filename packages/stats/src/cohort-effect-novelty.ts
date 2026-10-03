import type { CohortEffectNovelty, NoveltyFlag } from "@splitch/contracts";
import { fixedHorizonPValue } from "./fixed-horizon-ci";

/**
 * Two-sample z test on the difference of absolute effects: earliest bucket
 * versus later buckets pooled. Diagnostic only — never feeds the gate or token.
 */

export interface NoveltyContrastEstimate {
  readonly absoluteEffect: number;
  readonly samplingVar: number;
  readonly nControl: number;
  readonly nTreatment: number;
}

export function classifyCohortNovelty(input: {
  readonly earliest: NoveltyContrastEstimate | null;
  readonly laterPooled: NoveltyContrastEstimate | null;
  readonly alpha: number;
  readonly minArmN: number;
}): CohortEffectNovelty {
  validateAlpha(input.alpha);
  if (input.minArmN <= 0 || !Number.isSafeInteger(input.minArmN)) {
    throw new Error(`minArmN must be a positive safe integer; received ${String(input.minArmN)}.`);
  }

  if (
    input.earliest === null ||
    input.laterPooled === null ||
    !meetsMinArmN(input.earliest, input.minArmN) ||
    !meetsMinArmN(input.laterPooled, input.minArmN)
  ) {
    return { flag: "insufficient_data", alpha: input.alpha };
  }

  const diff = input.earliest.absoluteEffect - input.laterPooled.absoluteEffect;
  const samplingVar = input.earliest.samplingVar + input.laterPooled.samplingVar;
  if (!(samplingVar > 0) || !Number.isFinite(samplingVar)) {
    return { flag: "insufficient_data", alpha: input.alpha };
  }

  const standardError = Math.sqrt(samplingVar);
  const zStatistic = diff / standardError;
  const pValue = fixedHorizonPValue(diff, standardError);
  const flag: NoveltyFlag = pValue < input.alpha ? "detected" : "not_detected";
  return {
    flag,
    alpha: input.alpha,
    z_statistic: zStatistic,
    p_value: pValue,
  };
}

function meetsMinArmN(estimate: NoveltyContrastEstimate, minArmN: number): boolean {
  return estimate.nControl >= minArmN && estimate.nTreatment >= minArmN;
}

function validateAlpha(alpha: number): void {
  if (!Number.isFinite(alpha) || !(alpha > 0) || !(alpha < 1)) {
    throw new Error(`novelty alpha must be in (0, 1); received ${String(alpha)}.`);
  }
}
