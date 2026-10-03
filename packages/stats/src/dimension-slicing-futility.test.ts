import { describe, expect, it } from "vitest";
import { canonicalHash, resultTokenStats, type StatsInput } from "@splitch/contracts";
import { analyzeStats } from "./stats-engine";
import { ENGINE_RUN_ID, exposure } from "./stats-engine-test-helpers";

describe("StatsEngine.analyze Dimension slicing with MDE-exclusion futility", () => {
  it("surfaces futilityVerdict on overall and primary Dimension arms without changing the result token", async () => {
    const enabled = await analyzeStats(primaryDimensionFutilityInput("mde_exclusion"));
    const disabled = await analyzeStats(primaryDimensionFutilityInput("off"));

    const overall = armResult(enabled, "conversion", "treatment");
    const slice = dimensionArmResult(
      dimensionResult(enabled, "country", "US"),
      "conversion",
      "treatment",
    );
    const overallOff = armResult(disabled, "conversion", "treatment");
    const sliceOff = dimensionArmResult(
      dimensionResult(disabled, "country", "US"),
      "conversion",
      "treatment",
    );

    expect(overall.futilityVerdict).toBe("futile");
    expect(overall.futilityBecause).toMatch(/upper bound/);
    expect(slice.futilityVerdict).toBe(overall.futilityVerdict);
    expect(slice.futilityBecause).toBe(overall.futilityBecause);

    expect(overallOff.futilityVerdict).toBeUndefined();
    expect(overallOff.futilityBecause).toBeUndefined();
    expect(sliceOff.futilityVerdict).toBeUndefined();
    expect(sliceOff.futilityBecause).toBeUndefined();

    expect(await canonicalHash(resultTokenStats(enabled))).toBe(
      await canonicalHash(resultTokenStats(disabled)),
    );
  });
});

function primaryDimensionFutilityInput(futility: "mde_exclusion" | "off"): StatsInput {
  return {
    run_id: ENGINE_RUN_ID,
    analysis_version: "analysis-v1",
    confidence_level: 0.95,
    horizon: "fixed",
    // Locked N matches the slice so arms stay ready (not insufficient_n).
    sample_size_locked: 99,
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [
      { metric_id: "conversion", variant: "treatment" },
      {
        metric_id: "conversion",
        variant: "treatment",
        dimension_id: "country",
        dimension_value: "US",
      },
    ],
    guardrail_decisions: [],
    metric_variance_config: [],
    exposures: [
      ...dimensionExposures("control", "US", 99),
      ...dimensionExposures("treatment", "US", 99),
    ],
    // Matched conversion rates → absolute CS around zero; MDE 0.2 is excluded.
    metric_values: [
      ...dimensionMetricRows("control", "US", 50),
      ...dimensionMetricRows("treatment", "US", 50),
    ],
    pre_registration: {
      hypothesis: "Treatment raises conversion by at least 20pp",
      primary_metric_id: "conversion",
      metrics: [
        {
          metric_id: "conversion",
          desirability: "higher_is_better",
          mde_absolute: 0.2,
        },
      ],
      ship_rule: {
        required_margin: 0.02,
        margin_scale: "absolute",
        conflict_resolution: "primary_wins",
      },
      futility,
    },
    dimensions: [{ dimension_id: "country", class: "primary", values: ["US"] }],
  };
}

function armResult(
  output: Awaited<ReturnType<typeof analyzeStats>>,
  metricId: string,
  variant: string,
) {
  const result = output.arm_results.find(
    (arm) => arm.metric_id === metricId && arm.variant === variant,
  );
  if (result === undefined) {
    throw new Error(`test fixture missing ${variant} result for ${metricId}`);
  }
  return result;
}

function dimensionResult(
  output: Awaited<ReturnType<typeof analyzeStats>>,
  dimensionId: string,
  dimensionValue: string,
) {
  const result = output.dimension_results?.find(
    (dimension) =>
      dimension.dimension_id === dimensionId && dimension.dimension_value === dimensionValue,
  );
  if (result === undefined) {
    throw new Error(`test fixture missing ${dimensionId}=${dimensionValue} Dimension result`);
  }
  return result;
}

function dimensionArmResult(
  dimension: NonNullable<Awaited<ReturnType<typeof analyzeStats>>["dimension_results"]>[number],
  metricId: string,
  variant: string,
) {
  const result = dimension.arm_results.find(
    (arm) => arm.metric_id === metricId && arm.variant === variant,
  );
  if (result === undefined) {
    throw new Error(`test fixture missing ${variant} result for ${metricId}`);
  }
  return result;
}

function dimensionExposures(
  variant: string,
  country: string,
  count: number,
): StatsInput["exposures"] {
  return Array.from({ length: count }, (_unused, index) => ({
    ...exposure(variant, `${variant}_${country}_${index}`),
    dimension_values: { country },
  }));
}

function dimensionMetricRows(
  variant: string,
  country: string,
  conversions: number,
): StatsInput["metric_values"] {
  return Array.from({ length: conversions }, (_unused, index) => ({
    targeting_key_hash: `${variant}_${country}_${index}`,
    run_id: ENGINE_RUN_ID,
    metric_id: "conversion",
    metric_type: "binomial",
    value: 1,
    in_window: true,
  }));
}
