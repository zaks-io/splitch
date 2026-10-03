import { describe, expect, it } from "vitest";
import {
  familyCorrectionAlpha,
  harmonicNumber,
  largestRejectedRank,
  resolveFamilyCorrectionProcedure,
} from "./family-correction";

describe("family correction procedure", () => {
  it("defaults an omitted procedure to bh", () => {
    expect(resolveFamilyCorrectionProcedure(undefined)).toBe("bh");
  });

  it("computes the harmonic number used by BH-G", () => {
    expect(harmonicNumber(1)).toBe(1);
    expect(harmonicNumber(4)).toBe(1 + 1 / 2 + 1 / 3 + 1 / 4);
    expect(harmonicNumber(5)).toBeCloseTo(137 / 60, 12);
  });

  it("leaves BH alpha unchanged and divides BH-G by H_m", () => {
    expect(familyCorrectionAlpha(0.05, 5, "bh")).toBe(0.05);
    expect(familyCorrectionAlpha(0.05, 5, "bh_g")).toBeCloseTo(0.05 / (137 / 60), 12);
  });

  it("makes BH and BH-G agree when m is 1", () => {
    expect(largestRejectedRank([0.04], 0.05, "bh")).toBe(1);
    expect(largestRejectedRank([0.04], 0.05, "bh_g")).toBe(1);
    expect(largestRejectedRank([0.06], 0.05, "bh")).toBe(0);
    expect(largestRejectedRank([0.06], 0.05, "bh_g")).toBe(0);
  });

  it("keeps BH-G at or under alpha on the two-null adversarial dependence distribution where BH exceeds alpha", () => {
    // Two nulls; pairs at probability 0.025 each, (1,1) otherwise. Both
    // marginals are superuniform, yet BH rejects with probability 0.075 > 0.05.
    const alpha = 0.05;
    const outcomes: ReadonlyArray<{ pValues: readonly [number, number]; weight: number }> = [
      { pValues: [0.025, 1], weight: 0.025 },
      { pValues: [1, 0.025], weight: 0.025 },
      { pValues: [0.05, 0.05], weight: 0.025 },
      { pValues: [1, 1], weight: 0.925 },
    ];

    let bhRejectProbability = 0;
    let bhGRejectProbability = 0;
    for (const { pValues, weight } of outcomes) {
      const sorted = [...pValues].sort((left, right) => left - right);
      if (largestRejectedRank(sorted, alpha, "bh") > 0) bhRejectProbability += weight;
      if (largestRejectedRank(sorted, alpha, "bh_g") > 0) bhGRejectProbability += weight;
    }

    expect(bhRejectProbability).toBeCloseTo(0.075, 12);
    expect(bhRejectProbability).toBeGreaterThan(alpha);
    expect(bhGRejectProbability).toBeLessThanOrEqual(alpha);
  });

  it("fails loud on a non-positive family size", () => {
    expect(() => harmonicNumber(0)).toThrow(/positive integer family size/);
  });

  it("fails loud on an unknown procedure at the familyCorrectionAlpha boundary", () => {
    expect(() => familyCorrectionAlpha(0.05, 4, "e_bh" as never)).toThrow(
      /family_correction must be one of bh, bh_g/,
    );
    expect(() => familyCorrectionAlpha(0.05, 4, "typo" as never)).toThrow(
      /family_correction must be one of bh, bh_g/,
    );
  });

  it("fails loud on an unknown procedure at the largestRejectedRank boundary", () => {
    expect(() => largestRejectedRank([0.01, 0.02], 0.05, "typo" as never)).toThrow(
      /family_correction must be one of bh, bh_g/,
    );
  });

  it("fails loud on an unknown procedure at resolveFamilyCorrectionProcedure", () => {
    expect(() => resolveFamilyCorrectionProcedure("e_bh" as never)).toThrow(
      /family_correction must be one of bh, bh_g/,
    );
  });
});
