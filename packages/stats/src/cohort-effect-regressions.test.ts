import { describe, expect, it } from "vitest";
import { computeCohortEffect } from "./cohort-effect";
import {
  activationForEntities,
  COHORT_RUN_START,
  cohortStatsInput,
  prePeriodForEntities,
  type CohortEntitySpec,
} from "./cohort-effect-cases";
import { fixedHorizonAbsoluteInterval } from "./cohort-effect-estimate";
import { COHORT_EFFECT_NOVELTY_ALPHA } from "./cohort-effect-types";
import { estimateMetricComparison } from "./variance-estimators";

describe("cohort effect zero-variance / denominator", () => {
  it("represents zero sampling variance without throwing or claiming novelty", () => {
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(constantBinomialEntities(40, 0)),
      runStartedAt: COHORT_RUN_START,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    expect(diagnostic.comparisons[0]?.buckets[0]).toMatchObject({
      status: "zero_variance",
      absolute_effect: 0,
      absolute_ci_lower: null,
      absolute_ci_upper: null,
      n_control: 40,
      n_treatment: 40,
    });
    expect(diagnostic.comparisons[0]?.novelty.flag).toBe("insufficient_data");
  });

  it("labels Ratio buckets with enough Entities but zero denominator as insufficient_denominator", () => {
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(zeroDenominatorRatioEntities(40), {
        metricId: "ratio_metric",
        metricType: "ratio",
      }),
      runStartedAt: COHORT_RUN_START,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    expect(diagnostic.comparisons[0]?.buckets[0]).toMatchObject({
      status: "insufficient_denominator",
      absolute_effect: null,
      absolute_ci_lower: null,
      absolute_ci_upper: null,
      n_control: 40,
      n_treatment: 40,
    });
  });

  it("labels Ratio floating-point negative sampling variance as numerical_failure", () => {
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(negativeVarianceRatioEntities(40), {
        metricId: "ratio_metric",
        metricType: "ratio",
      }),
      runStartedAt: COHORT_RUN_START,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    expect(diagnostic.comparisons[0]?.buckets[0]).toMatchObject({
      status: "numerical_failure",
      absolute_ci_lower: null,
      absolute_ci_upper: null,
      n_control: 40,
      n_treatment: 40,
    });
    expect(diagnostic.comparisons[0]?.novelty.flag).toBe("insufficient_data");
  });
});

describe("cohort effect activation denominator", () => {
  it("filters activation_rows before bucketing so activated denominators match main analysis", () => {
    const { entities, activationRows } = activatedDenominatorEntities();
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(entities, { activationRows }),
      runStartedAt: COHORT_RUN_START,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    const day0 = diagnostic.comparisons[0]?.buckets[0];
    if (day0 === undefined) throw new Error("expected day_0");
    expect(day0.n_control).toBe(50);
    expect(day0.n_treatment).toBe(100);
    expect(day0.status).toBe("ready");
    expect(day0.absolute_effect).toBeCloseTo(0, 12);
  });
});

describe("cohort effect frozen variance settings", () => {
  it("forwards frozen winsorize:false and custom winsorize_pct into the estimator", () => {
    const entities = countEntitiesWithOutlier();
    const base = cohortStatsInput(entities, { metricId: "revenue", metricType: "count" });
    const disabledDay0 = day0Effect(
      cohortStatsInput(entities, {
        metricId: "revenue",
        metricType: "count",
        metricVarianceConfig: [varianceConfig("revenue", false, 90)],
      }),
    );
    const customDay0 = day0Effect(
      cohortStatsInput(entities, {
        metricId: "revenue",
        metricType: "count",
        metricVarianceConfig: [varianceConfig("revenue", true, 90)],
      }),
    );
    const uncapped = estimateMetricComparison({
      run_id: base.run_id,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: base.exposures,
      metric_values: base.metric_values,
      winsorize: false,
    });
    const winsorized = estimateMetricComparison({
      run_id: base.run_id,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: base.exposures,
      metric_values: base.metric_values,
      winsorize: true,
      winsorize_pct: 90,
    });
    expect(uncapped.absolute_lift).not.toBeCloseTo(winsorized.absolute_lift ?? Number.NaN, 6);
    expect(disabledDay0).toBeCloseTo(uncapped.absolute_lift ?? Number.NaN, 12);
    expect(customDay0).toBeCloseTo(winsorized.absolute_lift ?? Number.NaN, 12);
  });

  it("forwards frozen CUPED covariates into the per-bucket estimator", () => {
    const entities = cupedCountEntities();
    const withCuped = cohortStatsInput(entities, {
      metricId: "revenue",
      metricType: "count",
      metricVarianceConfig: [varianceConfig("revenue", false, 90, true)],
      prePeriodCovariates: prePeriodForEntities(entities, "revenue"),
    });
    const diagnostic = computeCohortEffect({
      statsInput: withCuped,
      runStartedAt: COHORT_RUN_START,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    const day0 = diagnostic.comparisons[0]?.buckets[0];
    if (day0 === undefined || day0.absolute_ci_lower === null || day0.absolute_ci_upper === null) {
      throw new Error("expected ready day_0 interval");
    }

    const cuped = estimateMetricComparison({
      run_id: withCuped.run_id,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: withCuped.exposures,
      metric_values: withCuped.metric_values,
      pre_period_covariates: withCuped.pre_period_covariates,
      winsorize: false,
      cuped: true,
      cuped_coverage_threshold_pct: 70,
    });
    const raw = estimateMetricComparison({
      run_id: withCuped.run_id,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment",
      exposures: withCuped.exposures,
      metric_values: withCuped.metric_values,
      winsorize: false,
      cuped: false,
    });
    expect(cuped.variance_techniques.cuped_method).toBe("pre_period");
    expect(cuped.absolute_lift_sampling_var).toBeLessThan(
      (raw.absolute_lift_sampling_var ?? 0) / 2,
    );
    expect(day0.absolute_effect).toBeCloseTo(cuped.absolute_lift ?? Number.NaN, 12);
    const expected = fixedHorizonAbsoluteInterval(
      cuped.absolute_lift ?? 0,
      cuped.absolute_lift_sampling_var ?? 1,
      COHORT_EFFECT_NOVELTY_ALPHA,
    );
    expect((day0.absolute_ci_upper - day0.absolute_ci_lower) / 2).toBeCloseTo(
      (expected.upper - expected.lower) / 2,
      12,
    );
  });
});

function day0Effect(statsInput: ReturnType<typeof cohortStatsInput>): number {
  const diagnostic = computeCohortEffect({
    statsInput,
    runStartedAt: COHORT_RUN_START,
    minArmN: 30,
  });
  if (diagnostic.state !== "ready") throw new Error("expected ready");
  const effect = diagnostic.comparisons[0]?.buckets[0]?.absolute_effect;
  if (effect === null || effect === undefined) throw new Error("expected absolute_effect");
  return effect;
}

function varianceConfig(metricId: string, winsorize: boolean, winsorizePct: number, cuped = false) {
  return {
    metric_id: metricId,
    winsorize,
    winsorize_pct: winsorizePct,
    cuped,
    cuped_coverage_threshold_pct: 70,
  };
}

function constantBinomialEntities(perArm: number, value: number): CohortEntitySpec[] {
  return armPairEntities(perArm, () => ({ value }));
}

function zeroDenominatorRatioEntities(perArm: number): CohortEntitySpec[] {
  return armPairEntities(perArm, () => ({ value: 0, numValue: 0, denomValue: 0 }));
}

function negativeVarianceRatioEntities(perArm: number): CohortEntitySpec[] {
  return armPairEntities(perArm, (_variant, index) => {
    const denomValue = 1 + (index % 3);
    return { value: 10_000 * denomValue, numValue: 10_000 * denomValue, denomValue };
  });
}

function countEntitiesWithOutlier(): CohortEntitySpec[] {
  return armPairEntities(40, (variant, index) => ({
    value:
      variant === "treatment" && index === 39
        ? 10_000
        : (variant === "control" ? 1 : 2) + (index % 5),
  }));
}

function cupedCountEntities(): CohortEntitySpec[] {
  return armPairEntities(40, (_variant, index) => {
    const covariate = (index % 10) - 4.5;
    return {
      value: 10 + covariate * 2 + (index % 3) * 0.01,
      prePeriodValue: covariate,
    };
  });
}

function armPairEntities(
  perArm: number,
  fields: (
    variant: "control" | "treatment",
    index: number,
  ) => Omit<CohortEntitySpec, "variant" | "dayOffset" | "index">,
): CohortEntitySpec[] {
  const entities: CohortEntitySpec[] = [];
  for (let index = 0; index < perArm; index += 1) {
    entities.push({ variant: "control", dayOffset: 0, index, ...fields("control", index) });
    entities.push({ variant: "treatment", dayOffset: 0, index, ...fields("treatment", index) });
  }
  return entities;
}

/** Control half-activated @ 20%; Treatment fully activated @ 20% — false 10% vs 20% without filter. */
function activatedDenominatorEntities(): {
  entities: CohortEntitySpec[];
  activationRows: ReturnType<typeof activationForEntities>;
} {
  const entities: CohortEntitySpec[] = [];
  for (let index = 0; index < 100; index += 1) {
    entities.push({ variant: "control", dayOffset: 0, index, value: index < 10 ? 1 : 0 });
    entities.push({ variant: "treatment", dayOffset: 0, index, value: index < 20 ? 1 : 0 });
  }
  const activatedControlIndexes = new Set(Array.from({ length: 50 }, (_, index) => index));
  return {
    entities,
    activationRows: [
      ...activationForEntities(
        entities.filter((entity) => entity.variant === "control"),
        { activatedIndexes: activatedControlIndexes },
      ),
      ...activationForEntities(
        entities.filter((entity) => entity.variant === "treatment"),
        { activateAll: true },
      ),
    ],
  };
}
