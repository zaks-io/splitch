import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_PLAN_MAX_ARM_COUNT,
  EXPERIMENT_PLAN_MIN_ALPHA,
  EXPERIMENT_PLAN_MIN_BASELINE_MEAN_ABS,
  EXPERIMENT_PLAN_MIN_DAILY_ELIGIBLE_ENTITIES,
  ExperimentPlanRequestSchema,
} from "./experiment-plan";

describe("ExperimentPlanRequestSchema arm bounds", () => {
  const base = {
    metricKind: "continuous" as const,
    baselineMean: 1,
    baselineVariance: 1,
    mdeAbsolute: 0.1,
    expectedDailyEligibleEntities: 1_000,
  };

  it("accepts armCount at the Experiment allocation key limit", () => {
    const parsed = ExperimentPlanRequestSchema.safeParse({
      ...base,
      armCount: EXPERIMENT_PLAN_MAX_ARM_COUNT,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects armCount above the Experiment allocation key limit", () => {
    const parsed = ExperimentPlanRequestSchema.safeParse({
      ...base,
      armCount: EXPERIMENT_PLAN_MAX_ARM_COUNT + 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an omitted-split armCount large enough to blow Array.from", () => {
    const parsed = ExperimentPlanRequestSchema.safeParse({
      ...base,
      armCount: 4_294_967_296,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects trafficSplit longer than the arm cap", () => {
    const parsed = ExperimentPlanRequestSchema.safeParse({
      ...base,
      armCount: 2,
      trafficSplit: Array.from({ length: EXPERIMENT_PLAN_MAX_ARM_COUNT + 1 }, () => 0.01),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects daily traffic below the documented floor", () => {
    const parsed = ExperimentPlanRequestSchema.safeParse({
      ...base,
      armCount: 2,
      expectedDailyEligibleEntities: EXPERIMENT_PLAN_MIN_DAILY_ELIGIBLE_ENTITIES / 10,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects non-zero baselineMean below the documented absolute floor", () => {
    const parsed = ExperimentPlanRequestSchema.safeParse({
      ...base,
      armCount: 2,
      baselineMean: EXPERIMENT_PLAN_MIN_BASELINE_MEAN_ABS / 10,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects alpha below the documented inverse-normal floor", () => {
    const parsed = ExperimentPlanRequestSchema.safeParse({
      ...base,
      armCount: 2,
      alpha: EXPERIMENT_PLAN_MIN_ALPHA / 10,
    });
    expect(parsed.success).toBe(false);
  });
});
