import {
  computeShipRecommendation,
  evaluateExperimentDecisionGate,
  type ArmResult,
  type PreRegistration,
  type StatsOutput,
  type VarianceTechniques,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr";
import { SequentialCI } from "./sequential-ci";
import { monteCarloTolerance } from "./sequential-ci-simulation";
import { seededNormal } from "./simulation-null-draws";

/**
 * Ship-recommendation margin clearance under any_goal (plan 2.4 Codex FIX):
 * when k Metric×Treatment comparisons have true lift exactly equal to the
 * required margin, shipping if any ordinary-alpha interval clears the margin
 * is not error-controlled (~39.7% false ships at k=20 goals; ~22.1% at one
 * goal × 10 Treatments). Margin clearance must use the always-valid interval
 * recomputed at alpha/k; FDR vs zero stays required.
 */

const ALPHA = 0.05;
const GOAL_COUNT = 20;
const TREATMENT_COUNT = 10;
const REQUIRED_MARGIN = 0.02;
const PER_ARM_N = 4_000;
const TARGET_N = 8_000;
const SAMPLING_VAR = 4e-5;

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

describe("ship recommendation simultaneous margin clearance simulation", () => {
  const mode = process.env.SPLITCH_STATS_SIMULATION_MODE === "audit" ? "audit" : "smoke";
  const seed = process.env.SPLITCH_STATS_SIMULATION_SEED ?? "424242";
  const requested = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "300", 10);
  const iterations = mode === "audit" ? requested : Math.min(requested, 300);
  const tolerance = monteCarloTolerance(ALPHA, iterations);

  it("keeps any_goal false-ship rate within alpha when 20 goals sit at the margin", {
    timeout: 180_000,
  }, () => {
    const rng = seededNormal(`${seed}:ship-margin-any-goal`);
    const adapter = new SequentialCI();
    let falseShips = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const arms = buildIterationArms(adapter, rng);
      const corrected = applyDecisionFamilyCorrection({
        arm_results: arms,
        decision_family: arms
          .filter((arm) => arm.variant === "treatment")
          .map((arm) => ({ metric_id: arm.metric_id, variant: arm.variant })),
        confidence_level: 1 - ALPHA,
        control_variant: "control",
      });
      const statsOutput = statsFromArms(corrected.arm_results);
      const recommendation = computeShipRecommendation({
        preRegistration: preRegistration(),
        gate: evaluateExperimentDecisionGate(
          statsOutput,
          { state: "frozen", variantId: "variant_control", variant: "control" },
          {
            plannedDurationDays: 7,
            overrideReason: null,
            runStartedAt: "2026-07-01T00:00:00.000Z",
            dataWatermark: "2026-07-08T00:00:00.000Z",
          },
        ),
        stats: statsOutput,
        controlVariant: "control",
        horizon: "sequential",
      });
      if (recommendation.recommendation?.verdict === "ship") {
        falseShips += 1;
      }
    }

    const falseShipRate = falseShips / iterations;
    console.info(
      `Ship margin any_goal ${mode} seed=${seed} n=${iterations} goals=${GOAL_COUNT} ` +
        `falseShip=${falseShipRate} tolerance=${tolerance}`,
    );
    expect(falseShipRate).toBeLessThanOrEqual(ALPHA + tolerance);
  });

  it("keeps any_goal false-ship rate within alpha when 10 Treatments sit at the margin", {
    timeout: 180_000,
  }, () => {
    const rng = seededNormal(`${seed}:ship-margin-any-goal-treatments`);
    const adapter = new SequentialCI();
    let falseShips = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const arms = buildMultiTreatmentArms(adapter, rng);
      const corrected = applyDecisionFamilyCorrection({
        arm_results: arms,
        decision_family: arms
          .filter((arm) => arm.variant !== "control")
          .map((arm) => ({ metric_id: arm.metric_id, variant: arm.variant })),
        confidence_level: 1 - ALPHA,
        control_variant: "control",
      });
      const statsOutput = statsFromMultiTreatmentArms(corrected.arm_results);
      const recommendation = computeShipRecommendation({
        preRegistration: multiTreatmentPreRegistration(),
        gate: evaluateExperimentDecisionGate(
          statsOutput,
          { state: "frozen", variantId: "variant_control", variant: "control" },
          {
            plannedDurationDays: 7,
            overrideReason: null,
            runStartedAt: "2026-07-01T00:00:00.000Z",
            dataWatermark: "2026-07-08T00:00:00.000Z",
          },
        ),
        stats: statsOutput,
        controlVariant: "control",
        horizon: "sequential",
      });
      if (recommendation.recommendation?.verdict === "ship") {
        falseShips += 1;
      }
    }

    const falseShipRate = falseShips / iterations;
    console.info(
      `Ship margin any_goal multi-treatment ${mode} seed=${seed} n=${iterations} ` +
        `treatments=${TREATMENT_COUNT} falseShip=${falseShipRate} tolerance=${tolerance}`,
    );
    expect(falseShipRate).toBeLessThanOrEqual(ALPHA + tolerance);
  });
});

function buildIterationArms(adapter: SequentialCI, rng: () => number): ArmResult[] {
  const arms: ArmResult[] = [];
  for (let goal = 0; goal < GOAL_COUNT; goal += 1) {
    const metricId = `goal_${goal}`;
    arms.push(controlArm(metricId));
    arms.push(
      treatmentArmAtMargin({
        adapter,
        rng,
        metricId,
        variant: "treatment",
        comparisonCount: GOAL_COUNT,
      }),
    );
  }
  return arms;
}

function buildMultiTreatmentArms(adapter: SequentialCI, rng: () => number): ArmResult[] {
  const metricId = "goal_0";
  const arms: ArmResult[] = [controlArm(metricId)];
  for (let index = 0; index < TREATMENT_COUNT; index += 1) {
    arms.push(
      treatmentArmAtMargin({
        adapter,
        rng,
        metricId,
        variant: `treatment_${index}`,
        comparisonCount: TREATMENT_COUNT,
      }),
    );
  }
  return arms;
}

function treatmentArmAtMargin(input: {
  adapter: SequentialCI;
  rng: () => number;
  metricId: string;
  variant: string;
  comparisonCount: number;
}): ArmResult {
  const estimate = REQUIRED_MARGIN + Math.sqrt(SAMPLING_VAR) * input.rng();
  const ordinary = input.adapter.compute({
    estimate,
    sampling_var: SAMPLING_VAR,
    n_t: PER_ARM_N,
    n_c: PER_ARM_N,
    alpha: ALPHA,
    target_n: TARGET_N,
  });
  const simultaneous = input.adapter.compute({
    estimate,
    sampling_var: SAMPLING_VAR,
    n_t: PER_ARM_N,
    n_c: PER_ARM_N,
    alpha: ALPHA / input.comparisonCount,
    target_n: TARGET_N,
  });
  return {
    variant: input.variant,
    metric_id: input.metricId,
    sample_size_n: PER_ARM_N,
    point_estimate: 0.2 + estimate,
    relative_lift_pct: (estimate / 0.2) * 100,
    ci_lower: ordinary.ci_lower * 100,
    ci_upper: ordinary.ci_upper * 100,
    p_value: ordinary.p_value,
    is_significant: false,
    in_bh_family: false,
    exploratory: true,
    decision_valid: false,
    status: "ready",
    variance_techniques: varianceTechniques,
    absolute_ci_lower: ordinary.ci_lower,
    absolute_ci_upper: ordinary.ci_upper,
    simultaneous_absolute_ci_lower: simultaneous.ci_lower,
    simultaneous_absolute_ci_upper: simultaneous.ci_upper,
  };
}

function controlArm(metricId: string): ArmResult {
  return {
    variant: "control",
    metric_id: metricId,
    sample_size_n: PER_ARM_N,
    point_estimate: 0.2,
    relative_lift_pct: null,
    ci_lower: null,
    ci_upper: null,
    p_value: 1,
    is_significant: false,
    in_bh_family: false,
    exploratory: true,
    decision_valid: false,
    status: "ready",
    variance_techniques: varianceTechniques,
  };
}

function preRegistration(): PreRegistration {
  return {
    hypothesis: "any locked goal clearing the margin ships",
    primary_metric_id: "goal_0",
    metrics: Array.from({ length: GOAL_COUNT }, (_, index) => ({
      metric_id: `goal_${index}`,
      desirability: "higher_is_better" as const,
    })),
    ship_rule: {
      required_margin: REQUIRED_MARGIN,
      margin_scale: "absolute",
      conflict_resolution: "any_goal",
    },
    futility: "off",
  };
}

function multiTreatmentPreRegistration(): PreRegistration {
  return {
    hypothesis: "any treatment clearing the margin ships",
    primary_metric_id: "goal_0",
    metrics: [{ metric_id: "goal_0", desirability: "higher_is_better" }],
    ship_rule: {
      required_margin: REQUIRED_MARGIN,
      margin_scale: "absolute",
      conflict_resolution: "any_goal",
    },
    futility: "off",
  };
}

function statsFromArms(armResults: readonly ArmResult[]): StatsOutput {
  return statsEnvelope(armResults, { control: PER_ARM_N, treatment: PER_ARM_N });
}

function statsFromMultiTreatmentArms(armResults: readonly ArmResult[]): StatsOutput {
  const exposureCounts: Record<string, number> = { control: PER_ARM_N };
  for (let index = 0; index < TREATMENT_COUNT; index += 1) {
    exposureCounts[`treatment_${index}`] = PER_ARM_N;
  }
  return statsEnvelope(armResults, exposureCounts);
}

function statsEnvelope(
  armResults: readonly ArmResult[],
  exposureCounts: Record<string, number>,
): StatsOutput {
  return {
    arm_results: [...armResults],
    srm: {
      srm_p_value: 0.62,
      srm_is_mismatch: false,
      observed_counts: exposureCounts,
      expected_counts: exposureCounts,
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
      exposure_counts: exposureCounts,
      deduped_counts: exposureCounts,
      low_n_warning: false,
    },
  };
}
