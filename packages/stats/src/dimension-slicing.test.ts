import { describe, expect, it } from "vitest";
import type { StatsInput } from "@splitch/contracts";
import { analyzeStats } from "./stats-engine";
import { ENGINE_RUN_ID, exposure } from "./stats-engine-test-helpers";

describe("StatsEngine.analyze Activation gates", () => {
  it("applies Activation before Dimension slicing and keeps SRM non-sliced", async () => {
    const output = await analyzeStats(activationGatedStatsInput());
    const control = armResult(output, "conversion", "control");
    const treatment = armResult(output, "conversion", "treatment");

    expect(control).toMatchObject({
      sample_size_n: 1,
      point_estimate: 1,
    });
    expect(treatment).toMatchObject({
      sample_size_n: 1,
      point_estimate: 1,
    });
    expect(output.srm.observed_counts).toEqual({ control: 2, treatment: 2 });
    expect(output.health.deduped_counts).toEqual({ control: 2, treatment: 2 });
    expect(output.health.activation_rates).toEqual({ control: 0.5, treatment: 0.5 });

    const activatedCountry = dimensionResult(output, "country", "US");
    const unactivatedCountry = dimensionResult(output, "country", "CA");

    expect(activatedCountry.sample_size_n).toBe(2);
    expect(dimensionArmResult(activatedCountry, "conversion", "control").sample_size_n).toBe(1);
    expect(dimensionArmResult(activatedCountry, "conversion", "treatment").sample_size_n).toBe(1);
    expect(unactivatedCountry.sample_size_n).toBe(0);
    expect(dimensionArmResult(unactivatedCountry, "conversion", "treatment").sample_size_n).toBe(0);
  });
});

describe("StatsEngine.analyze Dimension slicing", () => {
  it("reports per-slice low_n_warning and fixed-horizon insufficient_n", async () => {
    const output = await analyzeStats(fixedHorizonDimensionStatsInput());
    const country = dimensionResult(output, "country", "US");
    const control = dimensionArmResult(country, "conversion", "control");
    const treatment = dimensionArmResult(country, "conversion", "treatment");

    expect(country.sample_size_n).toBe(198);
    expect(country.low_n_warning).toBe(true);
    expect(control.status).toBe("insufficient_n");
    expect(treatment.status).toBe("insufficient_n");
  });

  it("ignores foreign-run exposures when slicing an ungated Dimension", async () => {
    // Rows from a prior run (with the same dimension value) must not inflate the
    // slice's sample size or suppress its low-N warning.
    const base = fixedHorizonDimensionStatsInput();
    const foreign = Array.from({ length: 500 }, (_unused, index) => ({
      ...exposure("treatment", `foreign_${index}`),
      run_id: "run_previous",
      dimension_values: { country: "US" },
    }));
    const output = await analyzeStats({
      ...base,
      exposures: [...base.exposures, ...foreign],
    });

    const country = dimensionResult(output, "country", "US");
    // 99 control + 99 treatment from THIS run only — the 500 foreign rows drop.
    expect(country.sample_size_n).toBe(198);
    expect(country.low_n_warning).toBe(true);
  });

  it("fails loud when a Primary Dimension is not in the locked decision family", async () => {
    const input = {
      ...fixedHorizonDimensionStatsInput(),
      decision_family: [{ metric_id: "conversion", variant: "treatment" }],
      dimensions: [{ dimension_id: "country", class: "primary", values: ["US"] }],
    } satisfies StatsInput;

    await expect(analyzeStats(input)).rejects.toThrow(/conversion\/treatment/);
  });

  it("fails loud when a Primary Dimension omits a treatment Variant from the locked family", async () => {
    const input = {
      ...fixedHorizonDimensionStatsInput(),
      allocation: { control: 34, treatment: 33, treatment_b: 33 },
      decision_family: [
        { metric_id: "conversion", variant: "treatment" },
        { metric_id: "conversion", variant: "treatment_b" },
        {
          metric_id: "conversion",
          variant: "treatment",
          dimension_id: "country",
          dimension_value: "US",
        },
      ],
    } satisfies StatsInput;

    await expect(analyzeStats(input)).rejects.toThrow(/conversion\/treatment_b/);
  });
});

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

function activationGatedStatsInput(): StatsInput {
  const controlActivated = "control_activated";
  const controlUnactivated = "control_unactivated";
  const treatmentActivated = "treatment_activated";
  const treatmentUnactivated = "treatment_unactivated";

  return {
    run_id: ENGINE_RUN_ID,
    confidence_level: 0.95,
    horizon: "sequential",
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
      {
        metric_id: "conversion",
        variant: "treatment",
        dimension_id: "country",
        dimension_value: "CA",
      },
    ],
    guardrail_decisions: [],
    metric_variance_config: [],
    exposures: [
      gatedExposure("control", controlActivated, ACTIVATION_TS, { country: "US" }),
      gatedExposure("control", controlUnactivated, FIRST_EXPOSURE_TS, { country: "CA" }),
      gatedExposure("treatment", treatmentActivated, ACTIVATION_TS, { country: "US" }),
      gatedExposure("treatment", treatmentUnactivated, FIRST_EXPOSURE_TS, { country: "CA" }),
    ],
    activation_rows: [
      activationRow(controlActivated, true),
      activationRow(controlUnactivated, false),
      activationRow(treatmentActivated, true),
      activationRow(treatmentUnactivated, false),
    ],
    metric_values: [
      binomialRow(controlActivated, 1),
      binomialRow(controlUnactivated, 0),
      binomialRow(treatmentActivated, 1),
      binomialRow(treatmentUnactivated, 0),
    ],
  };
}

const FIRST_EXPOSURE_TS = "2026-07-01T00:00:00.000Z";
const ACTIVATION_TS = "2026-07-01T00:05:00.000Z";

function gatedExposure(
  variant: string,
  targeting_key_hash: string,
  window_anchor: string,
  dimension_values: Record<string, string>,
): StatsInput["exposures"][number] {
  return {
    ...exposure(variant, targeting_key_hash),
    first_exposure_ts: FIRST_EXPOSURE_TS,
    window_anchor,
    dimension_values,
  };
}

function activationRow(
  targeting_key_hash: string,
  activated: boolean,
): NonNullable<StatsInput["activation_rows"]>[number] {
  return {
    targeting_key_hash,
    run_id: ENGINE_RUN_ID,
    activation_ts: ACTIVATION_TS,
    counterfactual: false,
    activated,
  };
}

function binomialRow(
  targeting_key_hash: string,
  value: number,
): StatsInput["metric_values"][number] {
  return {
    targeting_key_hash,
    run_id: ENGINE_RUN_ID,
    metric_id: "conversion",
    metric_type: "binomial",
    value,
    in_window: true,
  };
}

function fixedHorizonDimensionStatsInput(): StatsInput {
  return {
    run_id: ENGINE_RUN_ID,
    confidence_level: 0.95,
    horizon: "fixed",
    sample_size_locked: 100,
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
  };
}

function dimensionExposures(
  variant: string,
  country: string,
  count: number,
): StatsInput["exposures"] {
  return Array.from({ length: count }, (_unused, index) => ({
    ...exposure(variant, dimensionEntityId(variant, country, index)),
    dimension_values: { country },
  }));
}

function dimensionMetricRows(
  variant: string,
  country: string,
  conversions: number,
): StatsInput["metric_values"] {
  return Array.from({ length: conversions }, (_unused, index) =>
    binomialRow(dimensionEntityId(variant, country, index), 1),
  );
}

function dimensionEntityId(variant: string, country: string, index: number): string {
  return `${variant}_${country}_${index}`;
}
