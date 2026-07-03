import type { DecisionFamilyMember } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr.js";
import { armResult, resultKey } from "./decision-family-fdr-test-helpers.js";

describe("decision_family FDR golden fixtures", () => {
  it("matches a hand-ranked Benjamini-Hochberg adjusted significance set", () => {
    const decisionFamily: DecisionFamilyMember[] = [
      { metric_id: "metric_1", variant: "treatment_a" },
      { metric_id: "metric_2", variant: "treatment_a" },
      { metric_id: "metric_3", variant: "treatment_b" },
      { metric_id: "metric_4", variant: "treatment_b" },
      { metric_id: "metric_5", variant: "treatment_c" },
    ];
    const output = applyDecisionFamilyCorrection({
      confidence_level: 0.95,
      decision_family: decisionFamily,
      arm_results: [
        armResult("metric_5", "treatment_c", 0.2),
        armResult("metric_1", "treatment_a", 0.04),
        armResult("metric_3", "treatment_b", 0.015),
        armResult("metric_4", "treatment_b", 0.051),
        armResult("metric_2", "treatment_a", 0.001),
      ],
    });
    const significantKeys = output.arm_results
      .filter((result) => result.is_significant)
      .map(resultKey)
      .sort();

    expect(output.summary).toMatchObject({
      alpha: 0.05,
      family_size_m: 5,
    });
    expect(significantKeys).toEqual(["metric_2/treatment_a", "metric_3/treatment_b"]);
    expect(output.summary.rejected.map(resultKey).sort()).toEqual(significantKeys);
  });
});
