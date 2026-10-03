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
  /** Oriented contrast: sign(C) · (T̂ − (1 + margin) Ĉ). */
  readonly contrastEstimate: number;
  readonly contrastVar: number;
  readonly lower: number;
  readonly upper: number;
  readonly verdict: GuardrailVerdict;
  /**
   * Relative-% form of the oriented lower contrast bound so
   * GuardrailResult.ci_lower stays on the downside_threshold_pct scale:
   * threshold + 100 · L* / |Ĉ|. Null when Control's sign is uncertain.
   */
  readonly relativeLowerPct: number | null;
}

/**
 * Always-valid one-sided bounds for the relative non-inferiority contrast
 * oriented by Control sign: δ* = sign(C) · (T − (1 + margin) C), with
 * Var(δ*) = v_T + (1+margin)² v_C.
 *
 * Relative lift R = (T − C) / C satisfies δ_raw = C · (R − margin), so
 * δ* = |C| · (R − margin). Safe means R is established above the margin
 * regardless of whether Control is positive or negative.
 *
 * When Control's interval at the same critical multiplier as the contrast
 * spans 0, the orientation is undefined and the verdict is undecided (no
 * safe/breach claim). Dividing an unoriented lower bound by a negative
 * Control would also flip the relative-% mapping.
 *
 * Verdict (analysis-v2 Guardrail semantics):
 * - safe: lower > 0 — established non-inferiority at the locked margin
 * - breach: upper < 0 — affirmative evidence of harm past the margin
 * - undecided: lower ≤ 0 ≤ upper, or Control sign uncertain
 *
 * "Breach" is affirmative harm, not failure to establish safety. False-safety
 * is P(safe | true δ* < 0) and is controlled at alpha by Proposition B.1 when
 * the Control sign is identified.
 */
export function evaluateOneSidedGuardrail(
  input: OneSidedGuardrailContrastInput,
): OneSidedGuardrailBound {
  validateContrastInput(input);

  const weight = 1 + input.margin;
  const rawContrast = input.treatmentEstimate - weight * input.controlEstimate;
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

  const criticalMultiplier = boundary / standardError;
  const controlSign = identifiedControlSign(
    input.controlEstimate,
    input.controlVar,
    criticalMultiplier,
  );
  if (controlSign === "uncertain") {
    return {
      contrastEstimate: rawContrast,
      contrastVar,
      lower: rawContrast - boundary,
      upper: rawContrast + boundary,
      verdict: "undecided",
      relativeLowerPct: null,
    };
  }

  const contrastEstimate = controlSign * rawContrast;
  const lower = contrastEstimate - boundary;
  const upper = contrastEstimate + boundary;
  const verdict = classifyVerdict(lower, upper);
  const relativeLowerPct = input.margin * 100 + (100 * lower) / Math.abs(input.controlEstimate);

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

function identifiedControlSign(
  controlEstimate: number,
  controlVar: number,
  criticalMultiplier: number,
): 1 | -1 | "uncertain" {
  const halfWidth = criticalMultiplier * Math.sqrt(controlVar);
  if (!Number.isFinite(halfWidth) || halfWidth < 0) {
    throw new Error("Control sign half-width must be finite and non-negative.");
  }
  if (controlEstimate - halfWidth <= 0 && controlEstimate + halfWidth >= 0) {
    return "uncertain";
  }
  return controlEstimate > 0 ? 1 : -1;
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
