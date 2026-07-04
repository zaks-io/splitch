import type { DecisionFamilyMember } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr";
import { armResult, resultKey } from "./decision-family-fdr-test-helpers";

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

  it("expands Primary Dimension values into the locked BH family", () => {
    const decisionFamily: DecisionFamilyMember[] = [
      { metric_id: "conversion", variant: "treatment" },
      ...["US", "CA", "GB"].map((dimension_value) => ({
        metric_id: "conversion",
        variant: "treatment",
        dimension_id: "country",
        dimension_value,
      })),
    ];
    const output = applyDecisionFamilyCorrection({
      confidence_level: 0.95,
      decision_family: decisionFamily,
      arm_results: [
        armResult("conversion", "treatment", 0.2),
        dimensionArmResult("conversion", "treatment", "country", "US", 0.033),
        dimensionArmResult("conversion", "treatment", "country", "CA", 0.2),
        dimensionArmResult("conversion", "treatment", "country", "GB", 0.2),
      ],
    });
    const byKey = new Map(output.arm_results.map((result) => [decisionKey(result), result]));

    expect(output.summary.family_size_m).toBe(4);
    expect(byKey.get("conversion/treatment/country/US")).toMatchObject({
      p_value: 0.033,
      is_significant: false,
      in_bh_family: true,
      exploratory: false,
      decision_valid: true,
    });
  });
});

function dimensionArmResult(
  metricId: string,
  variant: string,
  dimensionId: string,
  dimensionValue: string,
  pValue: number,
) {
  return {
    ...armResult(metricId, variant, pValue),
    dimension_id: dimensionId,
    dimension_value: dimensionValue,
  };
}

function decisionKey(result: {
  metric_id: string;
  variant: string;
  dimension_id?: string | null;
  dimension_value?: string | null;
}): string {
  return [
    result.metric_id,
    result.variant,
    result.dimension_id ?? null,
    result.dimension_value ?? null,
  ]
    .filter((part) => part !== null)
    .join("/");
}
