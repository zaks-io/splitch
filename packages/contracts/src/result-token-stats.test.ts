import { describe, expect, it } from "vitest";
import {
  AnalysisResultsEnvelopeSchema,
  ArmResultSchema,
  canonicalHash,
  EstimandDisclosureSchema,
  resultTokenStats,
  type StatsOutput,
  StatsOutputSchema,
} from "./index";

const legacyArm = {
  variant: "treatment",
  metric_id: "revenue",
  sample_size_n: 250,
  point_estimate: 6.4,
  relative_lift_pct: 16.36,
  ci_lower: -4.1,
  ci_upper: 40.2,
  p_value: 0.21,
  is_significant: false,
  in_bh_family: true,
  exploratory: false,
  decision_valid: true,
  status: "ready",
  variance_techniques: {
    winsorized: true,
    winsorize_pct: 99.9,
    winsorize_cap: 10,
    cuped_applied: false,
    cuped_method: "none",
    cuped_attribute: null,
    cuped_attribute_source: null,
    cuped_coverage_pct: 0,
    delta_method: false,
  },
} as const;

const estimand = {
  label: "capped_additive_mean",
  decision_label: "capped_additive_mean",
  capped_entity_count: 1,
  uncapped: {
    label: "uncapped_additive_mean",
    point_estimate: 105.4,
    relative_lift_pct: 1816.36,
    ci_lower: -12,
    ci_upper: 5000,
    p_value: 0.4,
    status: "ready",
    cuped_applied: false,
  },
} as const;

function statsWith(arm: object): StatsOutput {
  return StatsOutputSchema.parse({
    arm_results: [arm],
    srm: {
      srm_p_value: 0.5,
      srm_is_mismatch: false,
      observed_counts: { control: 250, treatment: 250 },
      expected_counts: { control: 250, treatment: 250 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: [],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 250, treatment: 250 },
      deduped_counts: { control: 250, treatment: 250 },
      low_n_warning: false,
    },
    dimension_results: [
      {
        dimension_id: "country",
        dimension_value: "US",
        class: "primary",
        arm_results: [arm],
        sample_size_n: 500,
        low_n_warning: false,
        in_bh_family: true,
        exploratory: false,
        decision_valid: true,
      },
    ],
  });
}

describe("estimand disclosure contract", () => {
  it("still parses an arm recorded before the disclosure existed", () => {
    expect(ArmResultSchema.parse(legacyArm).estimand).toBeUndefined();
  });

  it("still parses a stored ready Results envelope whose arms predate the disclosure", () => {
    const envelope = AnalysisResultsEnvelopeSchema.parse({
      state: "ready",
      run_id: "run_1",
      control_variant: "control",
      data_watermark: "2026-07-05T00:00:00.000Z",
      result_token: `sha256:${"a".repeat(64)}`,
      stats: statsWith(legacyArm),
    });

    if (envelope.state !== "ready") throw new Error("expected a ready envelope");
    expect(envelope.stats.arm_results.every((arm) => arm.estimand === undefined)).toBe(true);
    expect(
      envelope.stats.dimension_results?.[0]?.arm_results.every((arm) => arm.estimand === undefined),
    ).toBe(true);
  });

  it("requires the capped-Entity count and the uncapped estimate together", () => {
    expect(EstimandDisclosureSchema.safeParse(estimand).success).toBe(true);
    expect(EstimandDisclosureSchema.safeParse({ ...estimand, uncapped: null }).success).toBe(false);
    expect(
      EstimandDisclosureSchema.safeParse({ ...estimand, capped_entity_count: null }).success,
    ).toBe(false);
  });
});

describe("resultTokenStats", () => {
  it("keeps the result token of a Run identical once the disclosure is added", async () => {
    const identity = { appId: "app_1", runId: "run_1", runConfigHash: "sha256:abc" };
    const legacy = statsWith(legacyArm);
    const disclosed = statsWith({ ...legacyArm, estimand });

    expect(await canonicalHash({ ...identity, stats: resultTokenStats(disclosed) })).toBe(
      await canonicalHash({ ...identity, stats: legacy }),
    );
  });

  it("still binds every decision-bearing field", async () => {
    const changed = statsWith({ ...legacyArm, point_estimate: 6.5, estimand });

    expect(await canonicalHash(resultTokenStats(changed))).not.toBe(
      await canonicalHash(resultTokenStats(statsWith({ ...legacyArm, estimand }))),
    );
  });
});
