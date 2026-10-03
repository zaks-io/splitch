import { describe, expect, it } from "vitest";
import { evaluateOneSidedGuardrail } from "./guardrail-one-sided";
import { normalMixtureOneSidedBoundary } from "./normal-mixture-one-sided";

const GOLDEN_TOLERANCE = 1e-12;

describe("one-sided guardrail contrast golden fixtures", () => {
  it("derives the Prop B.1 bound for treatment − (1 + margin) × control", () => {
    const treatmentEstimate = 9.5;
    const controlEstimate = 10;
    const treatmentVar = 0.02;
    const controlVar = 0.02;
    const margin = -0.1;
    const alpha = 0.05;
    const n_t = 2_500;
    const n_c = 2_500;
    const target_n = 5_000;

    const weight = 1 + margin;
    const contrastEstimate = treatmentEstimate - weight * controlEstimate;
    const contrastVar = treatmentVar + weight ** 2 * controlVar;
    const boundary = normalMixtureOneSidedBoundary(
      Math.sqrt(contrastVar),
      n_t + n_c,
      alpha,
      target_n,
    );
    const expectedLower = contrastEstimate - boundary;
    const expectedUpper = contrastEstimate + boundary;
    const expectedRelativeLower = margin * 100 + (100 * expectedLower) / controlEstimate;

    const result = evaluateOneSidedGuardrail({
      treatmentEstimate,
      controlEstimate,
      treatmentVar,
      controlVar,
      margin,
      alpha,
      n_t,
      n_c,
      target_n,
      horizon: "sequential",
    });

    expect(contrastEstimate).toBeCloseTo(0.5, 15);
    expect(result.lower).toBeCloseTo(expectedLower, 15);
    expect(result.upper).toBeCloseTo(expectedUpper, 15);
    expect(result.relativeLowerPct).toBeCloseTo(expectedRelativeLower, 15);
    // Wide arm variances leave 0 inside [L, U]: formula match, not a safety claim.
    expect(result.verdict).toBe("undecided");
    expect(Math.abs(result.lower - expectedLower)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
  });

  it("classifies breach, safe, and undecided from the contrast bounds", () => {
    const base = {
      treatmentVar: 0.0001,
      controlVar: 0.0001,
      margin: -0.1,
      alpha: 0.05,
      n_t: 2_500,
      n_c: 2_500,
      target_n: 5_000,
      horizon: "sequential" as const,
    };

    expect(
      evaluateOneSidedGuardrail({
        ...base,
        treatmentEstimate: 10,
        controlEstimate: 10,
      }).verdict,
    ).toBe("safe");

    expect(
      evaluateOneSidedGuardrail({
        ...base,
        treatmentEstimate: 8,
        controlEstimate: 10,
      }).verdict,
    ).toBe("breach");

    expect(
      evaluateOneSidedGuardrail({
        ...base,
        treatmentEstimate: 9.2,
        controlEstimate: 10,
        treatmentVar: 0.05,
        controlVar: 0.05,
      }).verdict,
    ).toBe("undecided");
  });
});
