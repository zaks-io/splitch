import { inverseNormalCdf } from "./normal-distribution";
import { normalMixtureOneSidedBoundary } from "./normal-mixture-one-sided";

export type GuardrailVerdict = "safe" | "breach" | "undecided";

export interface OneSidedGuardrailContrastInput {
  readonly treatmentEstimate: number;
  readonly controlEstimate: number;
  readonly treatmentVar: number;
  readonly controlVar: number;
  /** downside_threshold_pct / 100. E.g. -0.10 for "no worse than 10% down". */
  readonly margin: number;
  readonly alpha: number;
  readonly n_t: number;
  readonly n_c: number;
  readonly target_n: number;
  readonly horizon: "sequential" | "fixed";
}

export interface OneSidedGuardrailBound {
  /** δ̂ = T̂ − (1 + margin) Ĉ */
  readonly contrastEstimate: number;
  readonly contrastVar: number;
  readonly lower: number;
  readonly upper: number;
  readonly verdict: GuardrailVerdict;
  /**
   * Relative-% form of the lower contrast bound so GuardrailResult.ci_lower
   * stays on the downside_threshold_pct scale: threshold + 100 · L / Ĉ.
   */
  readonly relativeLowerPct: number;
}

/**
 * Always-valid one-sided bounds for the relative non-inferiority contrast
 * δ = T − (1 + margin) C, with Var(δ) = v_T + (1+margin)² v_C.
 *
 * Verdict (analysis-v2 Guardrail semantics):
 * - safe: lower > 0 — established non-inferiority at the locked margin
 * - breach: upper < 0 — affirmative evidence of harm past the margin
 * - undecided: lower ≤ 0 ≤ upper — neither claim is established
 *
 * "Breach" is affirmative harm, not failure to establish safety. False-safety
 * is P(safe | true δ < 0) and is controlled at alpha by Proposition B.1.
 */
export function evaluateOneSidedGuardrail(
  input: OneSidedGuardrailContrastInput,
): OneSidedGuardrailBound {
  validateContrastInput(input);

  const weight = 1 + input.margin;
  const contrastEstimate = input.treatmentEstimate - weight * input.controlEstimate;
  const contrastVar = input.treatmentVar + weight ** 2 * input.controlVar;
  if (!(contrastVar > 0) || !Number.isFinite(contrastVar)) {
    throw new Error("guardrail contrast variance must be finite and positive.");
  }

  const n = input.n_t + input.n_c;
  const standardError = Math.sqrt(contrastVar);
  const boundary =
    input.horizon === "sequential"
      ? normalMixtureOneSidedBoundary(standardError, n, input.alpha, input.target_n)
      : standardError * inverseNormalCdf(1 - input.alpha);

  if (!Number.isFinite(boundary) || boundary < 0) {
    throw new Error("one-sided guardrail boundary overflowed before producing a finite bound.");
  }

  const lower = contrastEstimate - boundary;
  const upper = contrastEstimate + boundary;
  const verdict = classifyVerdict(lower, upper);
  const relativeLowerPct =
    input.controlEstimate === 0
      ? Number.NaN
      : input.margin * 100 + (100 * lower) / input.controlEstimate;

  if (!Number.isFinite(relativeLowerPct)) {
    throw new Error(
      "relative lower pct for the one-sided guardrail bound must be finite when Control ≠ 0.",
    );
  }

  return {
    contrastEstimate,
    contrastVar,
    lower,
    upper,
    verdict,
    relativeLowerPct,
  };
}

function classifyVerdict(lower: number, upper: number): GuardrailVerdict {
  if (lower > 0) return "safe";
  if (upper < 0) return "breach";
  return "undecided";
}

function validateContrastInput(input: OneSidedGuardrailContrastInput): void {
  requireFiniteFields(input);
  requireNonNegativeVars(input.treatmentVar, input.controlVar);
  requireUnitInterval(input.alpha, "alpha");
  requirePositive(input.n_t, "n_t");
  requirePositive(input.n_c, "n_c");
  requirePositive(input.target_n, "target_n");
  if (input.controlEstimate === 0) {
    throw new Error(
      "Control estimate is 0; relative Guardrail margin is undefined (same as relative lift).",
    );
  }
}

function requireFiniteFields(input: OneSidedGuardrailContrastInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (name === "horizon") continue;
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${name} must be finite for the one-sided guardrail contrast.`);
    }
  }
}

function requireNonNegativeVars(treatmentVar: number, controlVar: number): void {
  if (!(treatmentVar >= 0) || !(controlVar >= 0)) {
    throw new Error("arm variances must be non-negative for the one-sided guardrail contrast.");
  }
}

function requireUnitInterval(value: number, name: string): void {
  if (!(value > 0) || !(value < 1)) {
    throw new Error(`${name} must be in (0, 1) for the one-sided guardrail contrast.`);
  }
}

function requirePositive(value: number, name: string): void {
  if (!(value > 0)) {
    throw new Error(`${name} must be positive for the one-sided guardrail contrast.`);
  }
}
