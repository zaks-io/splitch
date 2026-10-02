import type { VarianceTechniques } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { fiellerRelativeCi } from "./relative-ci";
import { deltaMethodRelativeCi } from "./relative-ci-delta";
import type { CIResult } from "./sequential-ci";
import type { MetricArmEstimate, MetricComparisonEstimate } from "./variance-estimator-types";

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

describe("delta-method relative interval comparator", () => {
  it("returns a finite interval on well-separated arms", () => {
    const bounds = deltaMethodRelativeCi(comparison(), decision());

    expect(bounds).not.toBeNull();
    expect(Number.isFinite(bounds?.lower)).toBe(true);
    expect(Number.isFinite(bounds?.upper)).toBe(true);
    expect(bounds?.lower).toBeLessThan(20);
    expect(bounds?.upper).toBeGreaterThan(20);
  });

  it("returns null when relative lift is undefined", () => {
    expect(deltaMethodRelativeCi(comparison({ relative_lift_pct: null }), decision())).toBeNull();
  });

  it("stays finite when Fieller goes unbounded near a zero Control mean", () => {
    const nearZero = comparison({
      control: arm(0.05, 4),
      absolute_lift_sampling_var: 4.4,
    });
    const ci = decision();

    expect(fiellerRelativeCi(nearZero, ci).lower).toBe(Number.NEGATIVE_INFINITY);
    const delta = deltaMethodRelativeCi(nearZero, ci);
    expect(delta).not.toBeNull();
    expect(Number.isFinite(delta?.lower)).toBe(true);
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

function decision(): CIResult {
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
  };
}
