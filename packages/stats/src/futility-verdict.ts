/**
 * MDE-exclusion futility for an always-valid absolute confidence sequence
 * (plan 2.12).
 *
 * Futile when the bound on the beneficial side of the interval excludes the
 * pre-registered absolute MDE: the effect is credibly smaller than the MDE.
 * The interval is closed, so equality on that bound is not exclusion
 * (`not_futile`). Relative intervals are out of scope — sequential Fieller
 * coverage is unproven (result-contracts.md).
 *
 * Likelihood-ratio futility is not adopted: Shim (2025) Truncated mSPRT for
 * practical significance (arXiv:2509.07892) was withdrawn in 2026 because the
 * denominator is not a supermartingale.
 *
 * Advisory only: never stops or Concludes a Run by itself.
 */

import type { MetricDirection } from "@splitch/contracts";

export const FUTILITY_VERDICTS = ["futile", "not_futile"] as const;

export type FutilityVerdict = (typeof FUTILITY_VERDICTS)[number];

export interface FutilityVerdictInput {
  readonly lower: number;
  readonly upper: number;
  /** Absolute MDE magnitude on the decision-interval scale (always positive). */
  readonly mdeAbsolute: number;
  readonly desirability: MetricDirection;
}

export interface FutilityClassification {
  readonly verdict: FutilityVerdict;
  /** One sentence explaining the verdict for Results. */
  readonly because: string;
}

export function classifyMdeExclusionFutility(input: FutilityVerdictInput): FutilityClassification {
  validateFutilityVerdictInput(input);

  const { lower, upper, mdeAbsolute, desirability } = input;
  const futile = desirability === "higher_is_better" ? upper < mdeAbsolute : lower > -mdeAbsolute;

  return {
    verdict: futile ? "futile" : "not_futile",
    because: becauseSentence({ futile, desirability, lower, upper, mdeAbsolute }),
  };
}

function validateFutilityVerdictInput(input: FutilityVerdictInput): void {
  if (input.desirability !== "higher_is_better" && input.desirability !== "lower_is_better") {
    throw new Error(
      `desirability must be "higher_is_better" or "lower_is_better"; received ${JSON.stringify(input.desirability)}.`,
    );
  }
  assertFiniteBound("lower", input.lower);
  assertFiniteBound("upper", input.upper);
  assertFiniteBound("mdeAbsolute", input.mdeAbsolute);
  if (input.lower > input.upper) {
    throw new Error(
      `confidence-sequence interval lower (${input.lower}) must be <= upper (${input.upper}).`,
    );
  }
  if (!(input.mdeAbsolute > 0)) {
    throw new Error(
      `mdeAbsolute must be a positive finite number; received ${String(input.mdeAbsolute)}.`,
    );
  }
}

function becauseSentence(args: {
  futile: boolean;
  desirability: MetricDirection;
  lower: number;
  upper: number;
  mdeAbsolute: number;
}): string {
  if (args.desirability === "higher_is_better") {
    return args.futile
      ? `The confidence-sequence upper bound (${args.upper}) is below the pre-registered absolute MDE (${args.mdeAbsolute}), so a beneficial effect of that size is excluded.`
      : `The confidence-sequence upper bound (${args.upper}) still reaches the pre-registered absolute MDE (${args.mdeAbsolute}).`;
  }
  const orientedMde = -args.mdeAbsolute;
  return args.futile
    ? `The confidence-sequence lower bound (${args.lower}) is above the pre-registered absolute MDE (${orientedMde}) for lower-is-better, so a beneficial effect of that size is excluded.`
    : `The confidence-sequence lower bound (${args.lower}) still reaches the pre-registered absolute MDE (${orientedMde}) for lower-is-better.`;
}

function assertFiniteBound(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number; received ${String(value)}.`);
  }
}
