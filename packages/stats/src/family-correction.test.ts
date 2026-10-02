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

  it("fails loud on a non-positive family size", () => {
    expect(() => harmonicNumber(0)).toThrow(/positive integer family size/);
  });
});
