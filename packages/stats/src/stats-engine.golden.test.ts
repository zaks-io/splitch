import { describe, expect, it } from "vitest";
import type { DimensionResult, StatsInput } from "@splitch/contracts";
import { analyzeStats } from "./stats-engine.js";
import { ENGINE_RUN_ID, binomialStatsInput, exposure } from "./stats-engine-test-helpers.js";

describe("StatsEngine golden fixtures", () => {
  it("assembles a full fixed-horizon two-arm Binomial StatsOutput", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 100,
        treatmentN: 100,
        controlConversions: 20,
        treatmentConversions: 40,
        horizon: "fixed",
        sampleSizeLocked: 100,
        includeGuardrail: true,
      }),
    );
    const conversionTreatment = output.arm_results.find(
      (result) => result.metric_id === "conversion" && result.variant === "treatment",
    );
    const guardrailTreatment = output.arm_results.find(
      (result) => result.metric_id === "guardrail_conversion" && result.variant === "treatment",
    );

    expect(output.srm).toEqual({
      srm_p_value: 1,
      srm_is_mismatch: false,
      observed_counts: { control: 100, treatment: 100 },
      expected_counts: { control: 100, treatment: 100 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    });
    expect(output.health).toEqual({
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 100, treatment: 100 },
      deduped_counts: { control: 100, treatment: 100 },
      low_n_warning: false,
    });

    expect(conversionTreatment).toMatchObject({
      sample_size_n: 100,
      point_estimate: 0.4,
      relative_lift_pct: 100,
      is_significant: true,
      in_bh_family: true,
      exploratory: false,
      decision_valid: true,
      status: "ready",
      variance_techniques: {
        winsorized: false,
        winsorize_pct: null,
        winsorize_cap: null,
        cuped_applied: false,
        cuped_method: "none",
        cuped_attribute: null,
        cuped_attribute_source: null,
        cuped_coverage_pct: 0,
        delta_method: false,
      },
    });
    expect(conversionTreatment?.ci_lower).toBeCloseTo(8.06954030815487, 12);
    expect(conversionTreatment?.ci_upper).toBeCloseTo(191.93045969184513, 12);
    expect(conversionTreatment?.p_value).toBeCloseTo(0.03300614049248174, 12);

    expect(guardrailTreatment?.ci_lower).toBe(conversionTreatment?.ci_lower);
    expect(output.guardrail_results).toEqual([
      {
        metric_id: "guardrail_conversion",
        variant: "treatment",
        ci_lower: guardrailTreatment?.ci_lower,
        threshold: 10,
        is_breached: true,
        in_bh_family: false,
        exploratory: false,
        decision_valid: true,
        breach_reason: `CI lower bound ${guardrailTreatment?.ci_lower} < threshold 10`,
      },
    ]);
  });

  it("emits Primary Dimension BH-corrected results and Secondary Dimension raw results", async () => {
    const output = await analyzeStats(dimensionGoldenInput());
    const countryResults =
      output.dimension_results?.filter((dimension) => dimension.dimension_id === "country") ?? [];
    const primaryUs = requiredDimension(output.dimension_results, "country", "US");
    const secondaryPro = requiredDimension(output.dimension_results, "plan", "pro");
    const primaryUsTreatment = requiredDimensionArm(primaryUs, "conversion", "treatment");
    const secondaryProTreatment = requiredDimensionArm(secondaryPro, "conversion", "treatment");

    expect(countryResults).toHaveLength(3);
    expect(primaryUs).toMatchObject({
      class: "primary",
      in_bh_family: true,
      exploratory: false,
      decision_valid: true,
      low_n_warning: false,
    });
    expect(primaryUsTreatment.p_value).toBeCloseTo(0.03300614049248174, 12);
    expect(primaryUsTreatment).toMatchObject({
      in_bh_family: true,
      exploratory: false,
      decision_valid: true,
      is_significant: false,
      status: "ready",
    });

    expect(secondaryPro).toMatchObject({
      class: "secondary",
      in_bh_family: false,
      exploratory: true,
      decision_valid: false,
      low_n_warning: false,
    });
    expect(secondaryProTreatment.p_value).toBeCloseTo(primaryUsTreatment.p_value, 12);
    expect(secondaryProTreatment).toMatchObject({
      in_bh_family: false,
      exploratory: true,
      decision_valid: false,
      is_significant: true,
      status: "ready",
    });
  });
});

function dimensionGoldenInput(): StatsInput {
  const slices = [
    { country: "US", plan: "pro", controlConversions: 20, treatmentConversions: 40 },
    { country: "CA", plan: "standard", controlConversions: 20, treatmentConversions: 20 },
    { country: "GB", plan: "standard", controlConversions: 20, treatmentConversions: 20 },
  ];

  return {
    run_id: ENGINE_RUN_ID,
    confidence_level: 0.95,
    horizon: "fixed",
    sample_size_locked: 100,
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [
      { metric_id: "conversion", variant: "treatment" },
      ...slices.map((slice) => ({
        metric_id: "conversion",
        variant: "treatment",
        dimension_id: "country",
        dimension_value: slice.country,
      })),
    ],
    guardrail_decisions: [],
    dimensions: [{ dimension_id: "plan", class: "secondary", values: ["pro"] }],
    exposures: slices.flatMap((slice) => [
      ...dimensionExposures("control", slice.country, slice.plan, 100),
      ...dimensionExposures("treatment", slice.country, slice.plan, 100),
    ]),
    metric_values: slices.flatMap((slice) => [
      ...dimensionMetricRows("control", slice.country, slice.controlConversions),
      ...dimensionMetricRows("treatment", slice.country, slice.treatmentConversions),
    ]),
  };
}

function dimensionExposures(
  variant: string,
  country: string,
  plan: string,
  count: number,
): StatsInput["exposures"] {
  return Array.from({ length: count }, (_unused, index) => ({
    ...exposure(variant, dimensionEntityId(variant, country, index)),
    dimension_values: { country, plan },
  }));
}

function dimensionMetricRows(
  variant: string,
  country: string,
  conversions: number,
): StatsInput["metric_values"] {
  return Array.from({ length: conversions }, (_unused, index) => ({
    targeting_key_hash: dimensionEntityId(variant, country, index),
    run_id: ENGINE_RUN_ID,
    metric_id: "conversion",
    metric_type: "binomial",
    value: 1,
    in_window: true,
  }));
}

function dimensionEntityId(variant: string, country: string, index: number): string {
  return `${variant}_${country}_${index}`;
}

function requiredDimension(
  dimensions: readonly DimensionResult[] | undefined,
  dimensionId: string,
  dimensionValue: string,
): DimensionResult {
  const result = dimensions?.find(
    (dimension) =>
      dimension.dimension_id === dimensionId && dimension.dimension_value === dimensionValue,
  );
  if (result === undefined) {
    throw new Error(`test fixture missing ${dimensionId}=${dimensionValue} Dimension result`);
  }
  return result;
}

function requiredDimensionArm(
  dimension: DimensionResult,
  metricId: string,
  variant: string,
): DimensionResult["arm_results"][number] {
  const result = dimension.arm_results.find(
    (arm) => arm.metric_id === metricId && arm.variant === variant,
  );
  if (result === undefined) {
    throw new Error(`test fixture missing ${variant} result for ${metricId}`);
  }
  return result;
}
