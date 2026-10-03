import {
  ANALYSIS_V1_VERSION,
  ANALYSIS_V2_VERSION,
  LEGACY_ANALYSIS_VERSION,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { analysisVersionPolicy } from "./analysis-version-policy";

describe("analysisVersionPolicy", () => {
  it("keeps chi-square SRM, BH, and two-sided Guardrails for legacy and analysis-v1", () => {
    for (const version of [LEGACY_ANALYSIS_VERSION, ANALYSIS_V1_VERSION]) {
      expect(analysisVersionPolicy(version)).toEqual({
        srm: "chi_square",
        familyCorrection: "bh",
        guardrailBound: "two_sided_relative",
      });
    }
  });

  it("selects sequential SRM, BH-G, and one-sided Guardrails under analysis-v2", () => {
    // Proposition C.3 needs BH-G for arbitrary dependence / stopping; plain BH
    // exceeds alpha on the two-null adversarial distribution in family-correction.
    // Proposition B.1 one-sided contrast is the Guardrail bound (C4).
    expect(analysisVersionPolicy(ANALYSIS_V2_VERSION)).toEqual({
      srm: "sequential_martingale",
      familyCorrection: "bh_g",
      guardrailBound: "one_sided_contrast",
    });
  });

  it("fails loud on an unknown analysis version with no newest fallthrough", () => {
    expect(() => analysisVersionPolicy("analysis-v99")).toThrow(
      /unsupported analysis_version "analysis-v99"/,
    );
    expect(() => analysisVersionPolicy("analysis-v99")).toThrow(/analysis-v2/);
  });
});
