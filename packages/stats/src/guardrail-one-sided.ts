import { inverseNormalCdf } from "./normal-distribution";
import { normalMixtureOneSidedBoundary } from "./normal-mixture-one-sided";
import { normalMixtureScale, rhoSquaredForTargetN } from "./sequential-ci";

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
  /** Oriented contrast: sign(C) · (T̂ − (1 + margin) Ĉ). Unoriented when sign is open. */
  readonly contrastEstimate: number;
  readonly contrastVar: number;
  readonly lower: number;
  readonly upper: number;
  readonly verdict: GuardrailVerdict;
  /** Whether Control's two-sided always-valid interval at α/2 excluded 0. */
  readonly controlSignEstablished: boolean;
}

/**
 * Always-valid Guardrail decision on the relative non-inferiority contrast
 * D = T − (1 + margin) C, oriented by an established Control sign.
 *
 * Joint validity at `alpha` uses a union bound (power cost: each piece runs at
 * α/2, so both the Control-sign interval and the contrast boundary are wider
 * than a single level-α procedure):
 *
 * 1. **Control sign (two-sided at α/2).** Establishing sign(C) requires excluding
 *    0 in either direction. A one-sided test whose side is chosen from Ĉ would
 *    be data-dependent and can double false-safety; the two-sided always-valid
 *    interval at α/2 pays for both sides. Sequential Runs use the two-sided
 *    normal-mixture CS; fixed-horizon Runs use z_{1−α/4}.
 * 2. **Oriented contrast (one-sided at α/2).** When sign is established,
 *    δ* = sign(C) · D with Var(δ*) = v_T + (1+margin)² v_C. Sequential Runs use
 *    Waudby-Smith Proposition B.1; fixed-horizon Runs use z_{1−α/2}.
 *
 * If Control's interval at α/2 spans 0, orientation is undefined and the
 * verdict is undecided (no safe/breach claim). The verdict otherwise comes only
 * from the contrast bound. P(false safe) ≤ P(wrong/open-handled via undecided) +
 * P(contrast L > 0 | true δ* < 0) ≤ α by the union bound.
 *
 * Relative lift R = (T − C) / C satisfies D = C · (R − margin), so
 * δ* = |C| · (R − margin) when sign(C) is identified. No relative-scale lower
 * bound is derived from the contrast; Fieller remains the reporting interval.
 *
 * Verdict (analysis-v2 Guardrail semantics):
 * - safe: lower > 0 — established non-inferiority at the locked margin
 * - breach: upper < 0 — affirmative evidence of harm past the margin
 * - undecided: lower ≤ 0 ≤ upper, or Control sign not established
 */
export function evaluateOneSidedGuardrail(
  input: OneSidedGuardrailContrastInput,
): OneSidedGuardrailBound {
  validateContrastInput(input);

  const alphaHalf = input.alpha / 2;
  const weight = 1 + input.margin;
  const rawContrast = input.treatmentEstimate - weight * input.controlEstimate;
  const contrastVar = input.treatmentVar + weight ** 2 * input.controlVar;
  if (!(contrastVar > 0) || !Number.isFinite(contrastVar)) {
    throw new Error("guardrail contrast variance must be finite and positive.");
  }

  const controlSign = identifiedControlSign(input, alphaHalf);
  const contrastN = input.n_t + input.n_c;
  const contrastSe = Math.sqrt(contrastVar);
  const contrastBoundary = oneSidedContrastBoundary(
    contrastSe,
    contrastN,
    alphaHalf,
    input.target_n,
    input.horizon,
  );

  if (controlSign === "uncertain") {
    return {
      contrastEstimate: rawContrast,
      contrastVar,
      lower: rawContrast - contrastBoundary,
      upper: rawContrast + contrastBoundary,
      verdict: "undecided",
      controlSignEstablished: false,
    };
  }

  const contrastEstimate = controlSign * rawContrast;
  const lower = contrastEstimate - contrastBoundary;
  const upper = contrastEstimate + contrastBoundary;
  return {
    contrastEstimate,
    contrastVar,
    lower,
    upper,
    verdict: classifyVerdict(lower, upper),
    controlSignEstablished: true,
  };
}

function identifiedControlSign(
  input: OneSidedGuardrailContrastInput,
  alphaSign: number,
): 1 | -1 | "uncertain" {
  const controlSe = Math.sqrt(input.controlVar);
  const halfWidth =
    input.horizon === "sequential"
      ? controlSe *
        normalMixtureScale(input.n_c, alphaSign, rhoSquaredForTargetN(alphaSign, input.target_n))
      : controlSe * inverseNormalCdf(1 - alphaSign / 2);

  if (!Number.isFinite(halfWidth) || halfWidth < 0) {
    throw new Error("Control sign half-width must be finite and non-negative.");
  }
  if (input.controlEstimate - halfWidth <= 0 && input.controlEstimate + halfWidth >= 0) {
    return "uncertain";
  }
  return input.controlEstimate > 0 ? 1 : -1;
}

function oneSidedContrastBoundary(
  standardError: number,
  n: number,
  alpha: number,
  targetN: number,
  horizon: "sequential" | "fixed",
): number {
  const boundary =
    horizon === "sequential"
      ? normalMixtureOneSidedBoundary(standardError, n, alpha, targetN)
      : standardError * inverseNormalCdf(1 - alpha);

  if (!Number.isFinite(boundary) || boundary < 0) {
    throw new Error("one-sided guardrail boundary overflowed before producing a finite bound.");
  }
  return boundary;
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
