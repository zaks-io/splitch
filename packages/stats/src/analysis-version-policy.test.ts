import {
  ANALYSIS_V1_VERSION,
  ANALYSIS_V2_VERSION,
  LEGACY_ANALYSIS_VERSION,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { analysisVersionPolicy } from "./analysis-version-policy";

describe("analysisVersionPolicy", () => {
  it("keeps chi-square SRM and BH for legacy and analysis-v1", () => {
    for (const version of [LEGACY_ANALYSIS_VERSION, ANALYSIS_V1_VERSION]) {
      expect(analysisVersionPolicy(version)).toEqual({
        srm: "chi_square",
        familyCorrection: "bh",
      });
    }
  });

  it("selects sequential SRM under analysis-v2 and keeps BH", () => {
    // ADR-0014 amendment: BH stop FDR was 0 under the recorded stopping
    // simulation, so plain BH did not exceed the FDR target.
    expect(analysisVersionPolicy(ANALYSIS_V2_VERSION)).toEqual({
      srm: "sequential_martingale",
      familyCorrection: "bh",
    });
  });

  it("fails loud on an unknown analysis version with no newest fallthrough", () => {
    expect(() => analysisVersionPolicy("analysis-v99")).toThrow(
      /unsupported analysis_version "analysis-v99"/,
    );
    expect(() => analysisVersionPolicy("analysis-v99")).toThrow(/analysis-v2/);
  });
});
