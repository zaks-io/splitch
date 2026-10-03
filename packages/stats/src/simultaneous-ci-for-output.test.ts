import type { StatsInput, VarianceTechniques } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { FixedHorizonCI } from "./fixed-horizon-ci";
import { SequentialCI } from "./sequential-ci";
import {
  shipMarginComparisonCount,
  simultaneousShipMarginCiForOutput,
} from "./simultaneous-ci-for-output";
import type { MetricArmEstimate, MetricComparisonEstimate } from "./variance-estimator-types";

const varianceTechniques: VarianceTechniques = {
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

function arm(variant: string, mean: number): MetricArmEstimate {
  return {
    variant,
    metric_id: "goal_a",
    metric_type: "binomial",
    sample_size_n: 1_000,
    point_estimate: mean,
    sampling_var: 0.00005,
    status: "ready",
    arm_variance: 0.00005,
    denominator_mean: null,
    zero_denominator_entity_count: 0,
    delta_method: false,
    variance_techniques: varianceTechniques,
  };
}

function comparison(): MetricComparisonEstimate {
  return {
    metric_id: "goal_a",
    metric_type: "binomial",
    control: arm("control", 0.2),
    treatment: arm("treatment", 0.22),
    absolute_lift: 0.02,
    absolute_lift_sampling_var: 0.0001,
    absolute_lift_var_components: { control: 0.00005, treatment: 0.00005 },
    relative_lift_pct: 10,
    sampling_var: 0.0001,
    status: "ready",
    variance_techniques: varianceTechniques,
  };
}

function baseInput(overrides: Partial<StatsInput> = {}): StatsInput {
  return {
    run_id: "run_sim_margin",
    analysis_version: "analysis-v2",
    confidence_level: 0.95,
    horizon: "sequential",
    target_n: 2_000,
    allocation: { control: 0.5, treatment: 0.5 },
    control_variant: "control",
    decision_family: [
      { metric_id: "goal_a", variant: "treatment" },
      { metric_id: "goal_b", variant: "treatment" },
    ],
    guardrail_decisions: [],
    metric_variance_config: [],
    exposures: [],
    metric_values: [],
    pre_registration: {
      hypothesis: "any goal ships",
      primary_metric_id: "goal_a",
      metrics: [
        { metric_id: "goal_a", desirability: "higher_is_better" },
        { metric_id: "goal_b", desirability: "higher_is_better" },
      ],
      ship_rule: {
        required_margin: 0.02,
        margin_scale: "absolute",
        conflict_resolution: "any_goal",
      },
      futility: "off",
    },
    ...overrides,
  };
}

describe("simultaneousShipMarginCiForOutput", () => {
  const adapters = {
    sequentialCI: new SequentialCI(),
    fixedHorizonCI: new FixedHorizonCI(),
  };

  it("omits simultaneous bounds for primary_wins", () => {
    const input = baseInput({
      pre_registration: {
        hypothesis: "primary only",
        primary_metric_id: "goal_a",
        metrics: [{ metric_id: "goal_a", desirability: "higher_is_better" }],
        ship_rule: {
          required_margin: 0.02,
          margin_scale: "absolute",
          conflict_resolution: "primary_wins",
        },
        futility: "off",
      },
    });
    expect(shipMarginComparisonCount(input)).toBe(1);
    expect(
      simultaneousShipMarginCiForOutput({
        statsInput: input,
        comparison: comparison(),
        adapters,
      }),
    ).toEqual({});
  });

  it("publishes a wider absolute interval at alpha/k for any_goal with k > 1", () => {
    const input = baseInput();
    expect(shipMarginComparisonCount(input)).toBe(2);
    const ordinary = adapters.sequentialCI.compute({
      estimate: 0.02,
      sampling_var: 0.0001,
      n_t: 1_000,
      n_c: 1_000,
      alpha: 0.05,
      target_n: 2_000,
    });
    const published = simultaneousShipMarginCiForOutput({
      statsInput: input,
      comparison: comparison(),
      adapters,
    });
    expect(published).toMatchObject({
      simultaneous_absolute_ci_lower: expect.any(Number),
      simultaneous_absolute_ci_upper: expect.any(Number),
    });
    const lower = (published as { simultaneous_absolute_ci_lower: number })
      .simultaneous_absolute_ci_lower;
    expect(lower).toBeLessThan(ordinary.ci_lower);
  });

  it("counts Metric×Treatment comparisons, not distinct Metrics", () => {
    const treatments = Array.from({ length: 10 }, (_, index) => `treatment_${index}`);
    const input = baseInput({
      allocation: Object.fromEntries([
        ["control", 1 / 11],
        ...treatments.map((variant) => [variant, 1 / 11] as const),
      ]),
      decision_family: treatments.map((variant) => ({ metric_id: "goal_a", variant })),
      pre_registration: {
        hypothesis: "any treatment ships",
        primary_metric_id: "goal_a",
        metrics: [{ metric_id: "goal_a", desirability: "higher_is_better" }],
        ship_rule: {
          required_margin: 0.02,
          margin_scale: "absolute",
          conflict_resolution: "any_goal",
        },
        futility: "off",
      },
    });
    expect(shipMarginComparisonCount(input)).toBe(10);
    const atMetricOnlyAlpha = adapters.sequentialCI.compute({
      estimate: 0.02,
      sampling_var: 0.0001,
      n_t: 1_000,
      n_c: 1_000,
      alpha: 0.05,
      target_n: 2_000,
    });
    const published = simultaneousShipMarginCiForOutput({
      statsInput: input,
      comparison: comparison(),
      adapters,
    });
    const lower = (published as { simultaneous_absolute_ci_lower: number })
      .simultaneous_absolute_ci_lower;
    expect(lower).toBeLessThan(atMetricOnlyAlpha.ci_lower);
  });
});
