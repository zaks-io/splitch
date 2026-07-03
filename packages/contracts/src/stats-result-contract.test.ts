import { describe, expect, it } from "vitest";
import {
  ArmResultSchema,
  DimensionResultSchema,
  GuardrailResultSchema,
  HealthMetricsSchema,
  SrmResultSchema,
  StatsOutputSchema,
  VarianceTechniquesSchema,
} from "./index.js";
import type { StatsEngine, StatsInput, StatsOutput } from "./index.js";

const varianceTechniques = {
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
  status: "ready",
  variance_techniques: varianceTechniques,
};

const srmResult = {
  srm_p_value: 0.51,
  srm_is_mismatch: false,
  observed_counts: { control: 250, treatment: 250 },
  expected_counts: { control: 250, treatment: 250 },
  activated_srm_p_value: null,
  activated_srm_mismatch: null,
};

const guardrailResult = {
  metric_id: "guardrail_1",
  variant: "treatment",
  ci_lower: -0.01,
  threshold: -0.05,
  is_breached: false,
  in_bh_family: false,
  exploratory: false,
  decision_valid: true,
  breach_reason: null,
};

const healthMetrics = {
  multiple_rate: 0.002,
  multiple_count: 1,
  activation_rates: null,
  activation_balance_p_value: null,
  activation_balance_mismatch: null,
  exposure_counts: { control: 255, treatment: 256 },
  deduped_counts: { control: 250, treatment: 250 },
  low_n_warning: false,
};

const dimensionResult = {
  dimension_id: "country",
  dimension_value: "US",
  class: "primary",
  arm_results: [armResult],
  sample_size_n: 120,
  in_bh_family: true,
  exploratory: false,
  decision_valid: true,
};

const statsOutput = {
  arm_results: [armResult],
  srm: srmResult,
  guardrail_results: [guardrailResult],
  health: healthMetrics,
  dimension_results: [dimensionResult],
};

function omitField(input: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...input };
  delete copy[field];
  return copy;
}

describe("StatsOutputSchema", () => {
  it("round-trips the final stats engine output shape", () => {
    const output = StatsOutputSchema.parse(statsOutput);

    expect(output.arm_results[0]?.decision_valid).toBe(true);
    expect(output.srm.activated_srm_p_value).toBeNull();
    expect(output.guardrail_results[0]?.in_bh_family).toBe(false);
    expect(output.health.low_n_warning).toBe(false);
    expect(output.dimension_results?.[0]?.class).toBe("primary");
  });

  it("keeps dimension_results optional on the output envelope", () => {
    const output = StatsOutputSchema.parse(omitField(statsOutput, "dimension_results"));

    expect(output.dimension_results).toBeUndefined();
  });
});

describe("decision-bearing result members", () => {
  it.each([
    ["ArmResult", ArmResultSchema],
    ["GuardrailResult", GuardrailResultSchema],
    ["DimensionResult", DimensionResultSchema],
  ])("declares the decision self-audit fields on %s", (_name, schema) => {
    expect(Object.keys(schema.shape)).toEqual(
      expect.arrayContaining(["decision_valid", "exploratory", "in_bh_family"]),
    );
  });

  it.each([
    ["ArmResult", ArmResultSchema, armResult],
    ["GuardrailResult", GuardrailResultSchema, guardrailResult],
    ["DimensionResult", DimensionResultSchema, dimensionResult],
  ])("rejects %s without decision_valid", (_name, schema, fixture) => {
    expect(schema.safeParse(omitField(fixture, "decision_valid")).success).toBe(false);
  });
});

describe("VarianceTechniquesSchema", () => {
  it("serializes never-silent nulls on the none and unwinsorized path", () => {
    const parsed = VarianceTechniquesSchema.parse(varianceTechniques);
    const serialized = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;

    expect(serialized).toMatchObject({
      cuped_method: null,
      winsorize_cap: null,
      winsorize_pct: null,
      cuped_coverage_pct: null,
      delta_method: false,
    });
    expect(Object.hasOwn(serialized, "cuped_method")).toBe(true);
    expect(Object.hasOwn(serialized, "winsorize_cap")).toBe(true);
  });

  it.each(["cuped_method", "winsorize_cap"])("rejects omitted %s", (field) => {
    expect(VarianceTechniquesSchema.safeParse(omitField(varianceTechniques, field)).success).toBe(
      false,
    );
  });
});

describe("SrmResultSchema", () => {
  it("uses the exact public SRM boundary and rejects chi2_stat", () => {
    expect(SrmResultSchema.parse(srmResult).srm_is_mismatch).toBe(false);
    expect(SrmResultSchema.safeParse({ ...srmResult, chi2_stat: 0 }).success).toBe(false);
  });
});

describe("HealthMetricsSchema", () => {
  it.each(["multiple_count", "deduped_counts", "low_n_warning"])("requires %s", (field) => {
    expect(HealthMetricsSchema.safeParse(omitField(healthMetrics, field)).success).toBe(false);
  });
});

describe("StatsEngine", () => {
  it("types analyze as StatsInput to StatsOutput", async () => {
    const engine: StatsEngine = {
      async analyze(input: StatsInput): Promise<StatsOutput> {
        return StatsOutputSchema.parse({
          ...statsOutput,
          arm_results: [
            {
              ...armResult,
              metric_id: input.decision_family[0]?.metric_id ?? armResult.metric_id,
            },
          ],
        });
      },
    };

    const input: StatsInput = {
      run_id: "run_1",
      confidence_level: 0.95,
      horizon: "sequential",
      decision_family: [{ metric_id: "metric_1", variant: "treatment" }],
      exposures: [],
      metric_values: [],
    };

    await expect(engine.analyze(input)).resolves.toMatchObject({
      arm_results: [{ metric_id: "metric_1" }],
    });
  });
});
