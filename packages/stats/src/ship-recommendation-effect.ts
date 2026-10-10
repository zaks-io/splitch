import type { MetricDirection, RopeScale } from "@splitch/contracts";

/**
 * Classify one Treatment arm's confidence sequence against desirability and the
 * ship rule's required margin. Interval and margin share `scale`.
 *
 * Beneficial: the margin-clearance CI clears +requiredMargin in the desirable
 * direction (ordinary alpha interval, or alpha/k when combining goals).
 * Harmful: the ordinary decision CI lies entirely on the wrong side of zero.
 * Undecided: neither (including a good-direction effect that has not cleared
 * the margin yet).
 */

export type MetricEffectVerdict = "beneficial" | "harmful" | "undecided";

export interface MetricEffectInput {
  desirability: MetricDirection;
  requiredMargin: number;
  scale: RopeScale;
  /** Ordinary decision interval (harm uses these bounds). */
  ciLower: number;
  ciUpper: number;
  /**
   * Interval used for margin clearance. When combining k > 1 goals this is the
   * Bonferroni alpha/k simultaneous interval; otherwise the ordinary interval.
   */
  marginCiLower?: number;
  marginCiUpper?: number;
}

export function classifyMetricEffect(input: MetricEffectInput): MetricEffectVerdict {
  assertFiniteMargin(input.requiredMargin);
  assertOrderedInterval(input.ciLower, input.ciUpper);
  const marginLower = input.marginCiLower ?? input.ciLower;
  const marginUpper = input.marginCiUpper ?? input.ciUpper;
  assertOrderedInterval(marginLower, marginUpper);

  if (clearsMargin(input.desirability, input.requiredMargin, marginLower, marginUpper)) {
    return "beneficial";
  }
  if (showsHarm(input.desirability, input.ciLower, input.ciUpper)) {
    return "harmful";
  }
  return "undecided";
}

/** True when the margin-clearance interval clears the required margin. */
export function clearsRequiredMargin(input: MetricEffectInput): boolean {
  assertFiniteMargin(input.requiredMargin);
  const marginLower = input.marginCiLower ?? input.ciLower;
  const marginUpper = input.marginCiUpper ?? input.ciUpper;
  assertOrderedInterval(marginLower, marginUpper);
  return clearsMargin(input.desirability, input.requiredMargin, marginLower, marginUpper);
}

/** Relative CI is published in percent; ship-rule relative margin is a fraction. */
export function marginOnIntervalScale(requiredMargin: number, scale: RopeScale): number {
  assertFiniteMargin(requiredMargin);
  return scale === "relative" ? requiredMargin * 100 : requiredMargin;
}

function clearsMargin(
  desirability: MetricDirection,
  requiredMargin: number,
  lower: number,
  upper: number,
): boolean {
  if (desirability === "higher_is_better") return lower > requiredMargin;
  if (desirability === "lower_is_better") return upper < -requiredMargin;
  throw new Error(`unknown desirability ${String(desirability)}`);
}

function showsHarm(desirability: MetricDirection, lower: number, upper: number): boolean {
  if (desirability === "higher_is_better") return upper < 0;
  if (desirability === "lower_is_better") return lower > 0;
  throw new Error(`unknown desirability ${String(desirability)}`);
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
