import { describe, expect, it } from "vitest";
import { ArmResultSchema } from "./stats-result-arm";

/**
 * Deploy-order compat: Analysis can emit absolute/simultaneous CI arm fields
 * before Control Plane deploys. .strict() ArmResultSchema must accept both
 * arms with the new fields and arms without them.
 */
const armResult = {
  variant: "treatment",
  metric_id: "metric_1",
  sample_size_n: 250,
  point_estimate: 0.14,
  relative_lift_pct: 12.5,
  ci_lower: 1.2,
  ci_upper: 23.8,
  p_value: 0.03,
  is_significant: true,
  in_bh_family: true,
  exploratory: false,
  decision_valid: true,
  status: "ready" as const,
  variance_techniques: {
    winsorized: false,
    winsorize_pct: null,
    winsorize_cap: null,
    cuped_applied: false,
    cuped_method: null,
    cuped_attribute: null,
    cuped_attribute_source: null,
    cuped_coverage_pct: null,
    delta_method: false,
  },
};

describe("ArmResult CI fields deploy compatibility", () => {
  it("accepts an arm carrying absolute and simultaneous CI fields", () => {
    const arm = ArmResultSchema.parse({
      ...armResult,
      absolute_ci_lower: 0.02,
      absolute_ci_upper: 0.08,
      simultaneous_absolute_ci_lower: 0.01,
      simultaneous_absolute_ci_upper: 0.09,
      simultaneous_ci_lower: -1,
      simultaneous_ci_upper: 20,
    });

    expect(arm.absolute_ci_lower).toBe(0.02);
    expect(arm.absolute_ci_upper).toBe(0.08);
    expect(arm.simultaneous_absolute_ci_lower).toBe(0.01);
    expect(arm.simultaneous_absolute_ci_upper).toBe(0.09);
    expect(arm.simultaneous_ci_lower).toBe(-1);
    expect(arm.simultaneous_ci_upper).toBe(20);
  });

  it("accepts an arm without absolute or simultaneous CI fields", () => {
    const arm = ArmResultSchema.parse(armResult);

    expect(arm.absolute_ci_lower).toBeUndefined();
    expect(arm.absolute_ci_upper).toBeUndefined();
    expect(arm.simultaneous_absolute_ci_lower).toBeUndefined();
    expect(arm.simultaneous_absolute_ci_upper).toBeUndefined();
    expect(arm.simultaneous_ci_lower).toBeUndefined();
    expect(arm.simultaneous_ci_upper).toBeUndefined();
  });
});
