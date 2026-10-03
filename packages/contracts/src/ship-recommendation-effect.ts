import type { MetricDirection } from "./leaf-schemas-experiment";
import type { RopeScale } from "./run-preregistration";

/**
 * Classify one Treatment arm's confidence sequence against desirability and the
 * ship rule's required margin. Interval and margin share `scale`.
 *
 * Beneficial: the CI clears +requiredMargin in the desirable direction.
 * Harmful: the CI lies entirely on the wrong side of zero.
 * Undecided: neither (including a good-direction effect that has not cleared
 * the margin yet).
 */

export type MetricEffectVerdict = "beneficial" | "harmful" | "undecided";

export interface MetricEffectInput {
  desirability: MetricDirection;
  requiredMargin: number;
  scale: RopeScale;
  ciLower: number;
  ciUpper: number;
}

export function classifyMetricEffect(input: MetricEffectInput): MetricEffectVerdict {
  assertFiniteMargin(input.requiredMargin);
  assertOrderedInterval(input.ciLower, input.ciUpper);

  if (input.desirability === "higher_is_better") {
    if (input.ciLower > input.requiredMargin) return "beneficial";
    if (input.ciUpper < 0) return "harmful";
    return "undecided";
  }
  if (input.desirability === "lower_is_better") {
    if (input.ciUpper < -input.requiredMargin) return "beneficial";
    if (input.ciLower > 0) return "harmful";
    return "undecided";
  }
  throw new Error(`unknown desirability ${String(input.desirability)}`);
}

/** Relative CI is published in percent; ship-rule relative margin is a fraction. */
export function marginOnIntervalScale(requiredMargin: number, scale: RopeScale): number {
  assertFiniteMargin(requiredMargin);
  return scale === "relative" ? requiredMargin * 100 : requiredMargin;
}

function assertFiniteMargin(margin: number): void {
  if (!(Number.isFinite(margin) && margin > 0)) {
    throw new Error(`requiredMargin must be a positive finite number; received ${String(margin)}`);
  }
}

function assertOrderedInterval(lower: number, upper: number): void {
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    throw new Error(
      `effect classification requires a finite interval; received [${String(lower)}, ${String(upper)}]`,
    );
  }
  if (lower > upper) {
    throw new Error(`interval lower (${lower}) must be <= upper (${upper})`);
  }
}
