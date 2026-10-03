import { describe, expect, it } from "vitest";
import { evaluateOneSidedGuardrail } from "./guardrail-one-sided";
import { inverseNormalCdf } from "./normal-distribution";
import { normalMixtureOneSidedBoundary } from "./normal-mixture-one-sided";
import { normalMixtureScale, rhoSquaredForTargetN } from "./sequential-ci";

const GOLDEN_TOLERANCE = 1e-12;
const BASE_SEQUENTIAL = {
  treatmentVar: 0.0001,
  controlVar: 0.0001,
  margin: -0.1,
  alpha: 0.05,
  n_t: 2_500,
  n_c: 2_500,
  target_n: 5_000,
  horizon: "sequential" as const,
};

describe("one-sided guardrail contrast golden fixtures", () => {
  it("splits alpha/2 for two-sided Control sign and one-sided Prop B.1 contrast", () => {
    const input = {
      treatmentEstimate: 9.5,
      controlEstimate: 10,
      treatmentVar: 0.02,
      controlVar: 0.02,
      margin: -0.1,
      alpha: 0.05,
      n_t: 2_500,
      n_c: 2_500,
      target_n: 5_000,
      horizon: "sequential" as const,
    };
    const expected = expectedSequentialBound(input);
    const result = evaluateOneSidedGuardrail(input);

    expect(expected.controlSignEstablished).toBe(true);
    expect(result.controlSignEstablished).toBe(true);
    expect(result.contrastEstimate).toBeCloseTo(0.5, 15);
    expect(result.lower).toBeCloseTo(expected.lower, 15);
    expect(result.upper).toBeCloseTo(expected.upper, 15);
    // Wide arm variances leave 0 inside [L, U]: formula match, not a safety claim.
    expect(result.verdict).toBe("undecided");
    expect(Math.abs(nonNull(result.lower) - expected.lower)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
  });

  it("classifies breach, safe, and undecided from the contrast bounds", () => {
    expect(
      evaluateOneSidedGuardrail({
        ...BASE_SEQUENTIAL,
        treatmentEstimate: 10,
        controlEstimate: 10,
      }).verdict,
    ).toBe("safe");

    expect(
      evaluateOneSidedGuardrail({
        ...BASE_SEQUENTIAL,
        treatmentEstimate: 8,
        controlEstimate: 10,
      }).verdict,
    ).toBe("breach");

    expect(
      evaluateOneSidedGuardrail({
        ...BASE_SEQUENTIAL,
        treatmentEstimate: 9.2,
        controlEstimate: 10,
        treatmentVar: 0.05,
        controlVar: 0.05,
      }).verdict,
    ).toBe("undecided");
  });

  it("orients by negative Control so relative-lift harm is not classified safe", () => {
    // C=-12, T=-9 → relative lift −25% (below −10% margin). Unoriented δ_raw > 0.
    const harmful = evaluateOneSidedGuardrail({
      ...BASE_SEQUENTIAL,
      treatmentEstimate: -9,
      controlEstimate: -12,
    });
    expect(harmful.verdict).toBe("breach");
    expect(harmful.controlSignEstablished).toBe(true);
    expect(harmful.contrastEstimate).toBeLessThan(0);

    // C=-12, T=-13 → relative lift +8.33% (above −10% margin).
    const safe = evaluateOneSidedGuardrail({
      ...BASE_SEQUENTIAL,
      treatmentEstimate: -13,
      controlEstimate: -12,
    });
    expect(safe.verdict).toBe("safe");
    expect(safe.contrastEstimate).toBeGreaterThan(0);
  });

  it("returns undecided when Control's two-sided α/2 interval spans 0", () => {
    const result = evaluateOneSidedGuardrail({
      treatmentEstimate: -9,
      controlEstimate: -0.01,
      treatmentVar: 1,
      controlVar: 1,
      margin: -0.1,
      alpha: 0.05,
      n_t: 50,
      n_c: 50,
      target_n: 100,
      horizon: "sequential",
    });

    expect(result.verdict).toBe("undecided");
    expect(result.controlSignEstablished).toBe(false);
  });

  it("uses fixed-horizon z critical values at the split alphas", () => {
    const alpha = 0.05;
    const alphaHalf = alpha / 2;
    const treatmentEstimate = 10;
    const controlEstimate = 10;
    const treatmentVar = 0.0001;
    const controlVar = 0.0001;
    const margin = -0.1;
    const contrastEstimate = treatmentEstimate - (1 + margin) * controlEstimate;
    const contrastVar = treatmentVar + (1 + margin) ** 2 * controlVar;
    const expectedBoundary = Math.sqrt(contrastVar) * inverseNormalCdf(1 - alphaHalf);

    const result = evaluateOneSidedGuardrail({
      treatmentEstimate,
      controlEstimate,
      treatmentVar,
      controlVar,
      margin,
      alpha,
      n_t: 500,
      n_c: 500,
      target_n: 1_000,
      horizon: "fixed",
    });

    expect(result.lower).toBeCloseTo(contrastEstimate - expectedBoundary, 15);
    expect(result.upper).toBeCloseTo(contrastEstimate + expectedBoundary, 15);
    expect(result.verdict).toBe("safe");
  });
});

function expectedSequentialBound(input: {
  readonly treatmentEstimate: number;
  readonly controlEstimate: number;
  readonly treatmentVar: number;
  readonly controlVar: number;
  readonly margin: number;
  readonly alpha: number;
  readonly n_t: number;
  readonly n_c: number;
  readonly target_n: number;
}): { lower: number; upper: number; controlSignEstablished: boolean } {
  const alphaHalf = input.alpha / 2;
  const weight = 1 + input.margin;
  const contrastEstimate = input.treatmentEstimate - weight * input.controlEstimate;
  const contrastVar = input.treatmentVar + weight ** 2 * input.controlVar;
  const contrastBoundary = normalMixtureOneSidedBoundary(
    Math.sqrt(contrastVar),
    input.n_t + input.n_c,
    alphaHalf,
    input.target_n,
  );
  const controlHalfWidth =
    Math.sqrt(input.controlVar) *
    normalMixtureScale(input.n_c, alphaHalf, rhoSquaredForTargetN(alphaHalf, input.target_n));
  return {
    lower: contrastEstimate - contrastBoundary,
    upper: contrastEstimate + contrastBoundary,
    controlSignEstablished: input.controlEstimate - controlHalfWidth > 0,
  };
}

function nonNull(value: number | null): number {
  if (value === null) throw new Error("expected a finite guardrail bound");
  return value;
}
