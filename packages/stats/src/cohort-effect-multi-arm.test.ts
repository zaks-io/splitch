import { describe, expect, it } from "vitest";
import { computeCohortEffect } from "./cohort-effect";
import { exposuresInBucket } from "./cohort-effect-buckets";
import { COHORT_RUN_START, cohortStatsInput, type CohortEntitySpec } from "./cohort-effect-cases";
import { estimateMetricComparison, estimateMetricComparisons } from "./variance-estimators";

describe("cohort effect multi-Treatment all-arm fit", () => {
  it("matches the all-arm estimator on the same cohort (not pair-only winsorization)", () => {
    // 3-arm Count at 90th-percentile winsorization: treatment_b outliers pull the
    // pooled cap above the Control+treatment_a pair-only cap, so pair-only and
    // all-arm absolute lifts diverge (≈9.8 vs 10). Cohort must use all-arm.
    const entities = threeArmWinsorizeEntities();
    const statsInput = cohortStatsInput(entities, {
      metricId: "revenue",
      metricType: "count",
      allocation: { control: 34, treatment_a: 33, treatment_b: 33 },
      decisionFamilyVariants: ["treatment_a", "treatment_b"],
      metricVarianceConfig: [
        {
          metric_id: "revenue",
          winsorize: true,
          winsorize_pct: 90,
          cuped: false,
          cuped_coverage_threshold_pct: 70,
        },
      ],
    });
    const day0Exposures = exposuresInBucket(statsInput.exposures, COHORT_RUN_START, "day_0");

    const allArm = estimateMetricComparisons({
      run_id: statsInput.run_id,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variants: ["treatment_a", "treatment_b"],
      exposures: day0Exposures,
      metric_values: statsInput.metric_values,
      winsorize: true,
      winsorize_pct: 90,
    }).comparisons.find((candidate) => candidate.treatment.variant === "treatment_a");
    const pairOnly = estimateMetricComparison({
      run_id: statsInput.run_id,
      metric_id: "revenue",
      metric_type: "count",
      control_variant: "control",
      treatment_variant: "treatment_a",
      exposures: day0Exposures,
      metric_values: statsInput.metric_values,
      winsorize: true,
      winsorize_pct: 90,
    });
    if (allArm?.absolute_lift === null || allArm === undefined) {
      throw new Error("expected all-arm absolute_lift");
    }
    if (pairOnly.absolute_lift === null) throw new Error("expected pair-only absolute_lift");
    expect(pairOnly.absolute_lift).not.toBeCloseTo(allArm.absolute_lift, 6);

    const diagnostic = computeCohortEffect({
      statsInput,
      runStartedAt: COHORT_RUN_START,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    const treatmentA = diagnostic.comparisons.find(
      (comparison) => comparison.treatment_variant === "treatment_a",
    );
    const day0 = treatmentA?.buckets.find((bucket) => bucket.bucket === "day_0");
    if (day0?.absolute_effect === null || day0 === undefined) {
      throw new Error("expected treatment_a day_0 absolute_effect");
    }
    expect(day0.absolute_effect).toBeCloseTo(allArm.absolute_lift, 12);
    expect(day0.absolute_effect).not.toBeCloseTo(pairOnly.absolute_lift, 6);
  });
});

function threeArmWinsorizeEntities(): CohortEntitySpec[] {
  const entities: CohortEntitySpec[] = [];
  for (let index = 0; index < 40; index += 1) {
    entities.push({
      variant: "control",
      dayOffset: 0,
      index,
      value: 10 + (index % 5),
    });
    entities.push({
      variant: "treatment_a",
      dayOffset: 0,
      index,
      value: 20 + (index % 5),
    });
    // Constant high treatment_b raises the pooled 90th-percentile cap (500) above
    // the Control+treatment_a pair-only cap (23), so pair-only lift ≈9.8 vs all-arm 10.
    entities.push({
      variant: "treatment_b",
      dayOffset: 0,
      index,
      value: 500,
    });
  }
  return entities;
}
