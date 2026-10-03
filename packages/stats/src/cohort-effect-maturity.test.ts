import { describe, expect, it } from "vitest";
import { computeCohortEffect } from "./cohort-effect";
import {
  activationForEntities,
  balancedEntities,
  COHORT_RUN_START,
  cohortConversionWindows,
  cohortStatsInput,
  type CohortEntitySpec,
} from "./cohort-effect-cases";

describe("cohort effect gated maturity", () => {
  it("anchors gated maturity on earliest valid Activation while bucketing by first Exposure", () => {
    const entities = balancedEntities([0], 40, 0.2, 0.4);
    const activationRows = activationForEntities(entities, { activateAll: true, delayDays: 8 });
    const statsInput = cohortStatsInput(entities, {
      activationRows,
      metricConversionWindows: cohortConversionWindows("conversion", 7 * 86_400_000),
    });

    const premature = computeCohortEffect({
      statsInput,
      runStartedAt: COHORT_RUN_START,
      analysisWatermark: "2026-07-11T00:00:00.000Z",
      minArmN: 30,
    });
    expect(premature).toEqual({ state: "unavailable", reason: "insufficient_entities" });

    const mature = computeCohortEffect({
      statsInput,
      runStartedAt: COHORT_RUN_START,
      analysisWatermark: "2026-07-16T00:00:00.000Z",
      minArmN: 30,
    });
    expect(mature.state).toBe("ready");
    if (mature.state !== "ready") throw new Error("expected ready");
    expect(mature.comparisons[0]?.buckets[0]).toMatchObject({
      bucket: "day_0",
      n_control: 40,
      n_treatment: 40,
      status: "ready",
    });
    expect(mature.comparisons[0]?.buckets[2]).toMatchObject({
      bucket: "day_7_plus",
      n_control: 0,
      n_treatment: 0,
    });
  });
});

describe("cohort effect overflow", () => {
  it("labels non-finite Count sampling variance as numerical_failure, not insufficient_n", () => {
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(overflowCountEntities(40), {
        metricId: "revenue",
        metricType: "count",
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

function overflowCountEntities(perArm: number): CohortEntitySpec[] {
  const entities: CohortEntitySpec[] = [];
  for (let index = 0; index < perArm; index += 1) {
    const value = index === 0 ? 1e308 : 1;
    entities.push({ variant: "control", dayOffset: 0, index, value });
    entities.push({ variant: "treatment", dayOffset: 0, index, value });
  }
  return entities;
}
