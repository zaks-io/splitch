import { describe, expect, it } from "vitest";
import type { StatsInput } from "@splitch/contracts";
import { analyzeStats } from "./stats-engine";
import { ENGINE_RUN_ID, exposure } from "./stats-engine-test-helpers";

describe("StatsEngine.analyze Dimension slicing with pre-registered ROPE", () => {
  it("preserves ropeVerdict on a primary Dimension slice", async () => {
    const output = await analyzeStats(primaryDimensionRopeInput());
    const overall = armResult(output, "conversion", "treatment");
    const slice = dimensionArmResult(
      dimensionResult(output, "country", "US"),
      "conversion",
      "treatment",
    );

    expect(overall.ropeVerdict).toBeDefined();
    expect(overall.ropeScale).toBe("absolute");
    expect(slice.ropeVerdict).toBe(overall.ropeVerdict);
    expect(slice.ropeScale).toBe("absolute");
  });
});

function primaryDimensionRopeInput(): StatsInput {
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
    metric_values: [
      ...dimensionMetricRows("control", "US", 20),
      ...dimensionMetricRows("treatment", "US", 40),
    ],
    pre_registration: {
      hypothesis: "Treatment raises conversion in US",
      primary_metric_id: "conversion",
      metrics: [
        {
          metric_id: "conversion",
          desirability: "higher_is_better",
          rope: { lower: -0.05, upper: 0.05, scale: "absolute" },
        },
      ],
      ship_rule: {
        required_margin: 0.02,
        margin_scale: "absolute",
        conflict_resolution: "primary_wins",
      },
      futility: "off",
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
