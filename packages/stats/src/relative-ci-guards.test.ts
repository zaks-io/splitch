import type { VarianceTechniques } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { fiellerRelativeCi } from "./relative-ci";
import type { CIResult } from "./sequential-ci";
import type { MetricArmEstimate, MetricComparisonEstimate } from "./variance-estimator-types";

/**
 * Every guard in fiellerRelativeCi refuses a degenerate input the engine cannot
 * produce end to end, which is exactly why they are worth pinning here: an A/B
 * fixture reaches none of them, so a mutation that deletes one survives the
 * property suite untouched and the failure only ever appears in production, as
 * a NaN or an Infinity where a percentage belongs.
 */

const NO_TECHNIQUES: VarianceTechniques = {
  winsorized: false,
  winsorize_pct: null,
  winsorize_cap: null,
  cuped_applied: false,
  cuped_method: null,
  cuped_attribute: null,
  cuped_attribute_source: null,
  cuped_coverage_pct: null,
  delta_method: false,
};

describe("Fieller guards on degenerate inputs", () => {
  it("returns a bounded interval on well-separated arms", () => {
    const bounds = fiellerRelativeCi(comparison(), decisionCi());

    expect(Number.isFinite(bounds.lower)).toBe(true);
    expect(Number.isFinite(bounds.upper)).toBe(true);
    expect(bounds.lower).toBeLessThan(bounds.upper);
  });

  it.each([
    ["a null Control point estimate", { control: arm(null, 0.4) }],
    ["a null Treatment point estimate", { treatment: arm(null, 0.4) }],
    ["a Control mean of exactly zero", { control: arm(0, 0.4) }],
    ["null variance components", { absolute_lift_var_components: null }],
    ["a null absolute-lift variance", { absolute_lift_sampling_var: null }],
    [
      "an absolute-lift variance of exactly zero",
      {
        absolute_lift_sampling_var: 0,
        absolute_lift_var_components: { control: 0, treatment: 0 },
      },
    ],
  ])("publishes an unbounded interval on %s", (_case, patch) => {
    expect(fiellerRelativeCi(comparison(patch), decisionCi())).toEqual({
      lower: Number.NEGATIVE_INFINITY,
      upper: Number.POSITIVE_INFINITY,
    });
  });

  it.each([
    ["a zero-width decision interval", { ci_lower: 4, ci_upper: 4 }],
    ["an unbounded decision interval", { ci_lower: -Infinity, ci_upper: Infinity }],
    ["an inverted decision interval", { ci_lower: 6, ci_upper: 2 }],
    ["a NaN decision bound", { ci_upper: Number.NaN }],
  ])("publishes an unbounded interval on %s", (_case, patch) => {
    expect(fiellerRelativeCi(comparison(), decisionCi(patch))).toEqual({
      lower: Number.NEGATIVE_INFINITY,
      upper: Number.POSITIVE_INFINITY,
    });
  });

  it("publishes an unbounded interval when the Control mean is not separated from zero", () => {
    // Fieller's leading coefficient a = C^2 - k^2 vC goes non-positive here, so
    // the ratio has no bounded interval however large the absolute difference is.
    const bounds = fiellerRelativeCi(
      comparison({ control: arm(0.05, 4), absolute_lift_sampling_var: 4.4 }),
      decisionCi(),
    );

    expect(bounds.lower).toBe(Number.NEGATIVE_INFINITY);
    expect(bounds.upper).toBe(Number.POSITIVE_INFINITY);
  });

  it("collapses to the point estimate when the Treatment arm carries all the variance", () => {
    // vT = 0 drives the discriminant to its floor, the case the sqrt clamp
    // exists for. The interval must still be a number, and both roots land on
    // the ratio itself.
    const bounds = fiellerRelativeCi(
      comparison({
        control: arm(10, 0.8),
        treatment: arm(12, 0),
        absolute_lift_var_components: { control: 0.8, treatment: 0 },
      }),
      decisionCi(),
    );

    expect(Number.isNaN(bounds.lower)).toBe(false);
    expect(bounds.lower).toBeLessThan(20);
    expect(bounds.upper).toBeGreaterThan(20);
  });
});

function comparison(patch: Partial<MetricComparisonEstimate> = {}): MetricComparisonEstimate {
  const control = patch.control ?? arm(10, 0.4);
  const treatment = patch.treatment ?? arm(12, 0.4);
  return {
    metric_id: "revenue",
    metric_type: "revenue",
    control,
    treatment,
    absolute_lift: (treatment.point_estimate ?? 0) - (control.point_estimate ?? 0),
    absolute_lift_sampling_var: 0.8,
    absolute_lift_var_components: {
      control: control.sampling_var ?? 0,
      treatment: treatment.sampling_var ?? 0,
    },
    relative_lift_pct: 20,
    sampling_var: 0.8,
    status: "ready",
    variance_techniques: NO_TECHNIQUES,
    ...patch,
  };
}

function arm(pointEstimate: number | null, samplingVar: number): MetricArmEstimate {
  return {
    variant: "control",
    metric_id: "revenue",
    metric_type: "revenue",
    sample_size_n: 500,
    point_estimate: pointEstimate,
    sampling_var: samplingVar,
    status: "ready",
    arm_variance: samplingVar * 500,
    denominator_mean: null,
    zero_denominator_entity_count: 0,
    delta_method: false,
    variance_techniques: NO_TECHNIQUES,
  };
}

function decisionCi(patch: Partial<CIResult> = {}): CIResult {
  return {
    ci_lower: 0.25,
    ci_upper: 3.75,
    p_value: 0.025,
    mode: "fixed",
    status: "ok",
    source: { family: "fixed-horizon-two-sample-z-test", references: [] },
    n: 1000,
    peeking_allowed: false,
    boundary: 1.75,
    critical_value: 1.959963984540054,
    ...patch,
  };
}
