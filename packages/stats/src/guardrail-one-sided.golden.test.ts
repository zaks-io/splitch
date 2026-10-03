import { describe, expect, it } from "vitest";
import { evaluateOneSidedGuardrail } from "./guardrail-one-sided";
import { normalMixtureOneSidedBoundary } from "./normal-mixture-one-sided";

const GOLDEN_TOLERANCE = 1e-12;

describe("one-sided guardrail contrast golden fixtures", () => {
  it("derives the Prop B.1 bound for sign(C) · (treatment − (1 + margin) × control)", () => {
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

  it("orients by negative Control so relative-lift harm is not classified safe", () => {
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

    // C=-12, T=-9 → relative lift −25% (below −10% margin). Unoriented δ_raw > 0.
    const harmful = evaluateOneSidedGuardrail({
      ...base,
      treatmentEstimate: -9,
      controlEstimate: -12,
    });
    expect(harmful.verdict).toBe("breach");
    expect(harmful.contrastEstimate).toBeLessThan(0);
    expect(harmful.relativeLowerPct).not.toBeNull();
    expect(harmful.relativeLowerPct ?? 0).toBeLessThan(-10);

    // C=-12, T=-13 → relative lift +8.33% (above −10% margin).
    const safe = evaluateOneSidedGuardrail({
      ...base,
      treatmentEstimate: -13,
      controlEstimate: -12,
    });
    expect(safe.verdict).toBe("safe");
    expect(safe.contrastEstimate).toBeGreaterThan(0);
  });

  it("returns undecided when Control's interval spans 0", () => {
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
    expect(result.relativeLowerPct).toBeNull();
  });
});
