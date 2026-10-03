import { describe, expect, it } from "vitest";
import { computeCohortEffect } from "./cohort-effect";
import { exposureDayBucket } from "./cohort-effect-buckets";
import {
  balancedEntities,
  COHORT_ANALYSIS_WATERMARK,
  COHORT_RUN_START,
  cohortConversionWindows,
  cohortStatsInput,
} from "./cohort-effect-cases";
import { fixedHorizonAbsoluteInterval } from "./cohort-effect-estimate";
import { classifyCohortNovelty } from "./cohort-effect-novelty";
import { COHORT_EFFECT_MIN_ARM_N, COHORT_EFFECT_NOVELTY_ALPHA } from "./cohort-effect-types";
import { inverseNormalCdf } from "./normal-distribution";

describe("exposureDayBucket", () => {
  it.each([
    { days: 0, bucket: "day_0" as const },
    { days: 1, bucket: "days_1_6" as const },
    { days: 6, bucket: "days_1_6" as const },
    { days: 7, bucket: "day_7_plus" as const },
    { days: 30, bucket: "day_7_plus" as const },
  ])("maps day offset $days to $bucket", ({ days, bucket }) => {
    const ts = new Date(Date.parse(COHORT_RUN_START) + days * 86_400_000).toISOString();
    expect(exposureDayBucket(ts, COHORT_RUN_START)).toBe(bucket);
  });

  it("fails loud when first_exposure_ts precedes Run start", () => {
    expect(() => exposureDayBucket("2026-06-30T00:00:00.000Z", COHORT_RUN_START)).toThrow(
      /before Run start/,
    );
  });
});

describe("fixedHorizonAbsoluteInterval", () => {
  it("matches the two-sided z critical value at alpha 0.05", () => {
    const interval = fixedHorizonAbsoluteInterval(0.1, 0.01, 0.05);
    const critical = inverseNormalCdf(0.975);
    expect(interval.lower).toBeCloseTo(0.1 - critical * 0.1, 12);
    expect(interval.upper).toBeCloseTo(0.1 + critical * 0.1, 12);
  });
});

describe("classifyCohortNovelty", () => {
  it("returns insufficient_data below the per-arm minimum", () => {
    const novelty = classifyCohortNovelty({
      earliest: { absoluteEffect: 0.2, samplingVar: 0.001, nControl: 10, nTreatment: 10 },
      laterPooled: { absoluteEffect: 0.01, samplingVar: 0.001, nControl: 40, nTreatment: 40 },
      alpha: COHORT_EFFECT_NOVELTY_ALPHA,
      minArmN: COHORT_EFFECT_MIN_ARM_N,
    });
    expect(novelty).toEqual({ flag: "insufficient_data", alpha: COHORT_EFFECT_NOVELTY_ALPHA });
  });

  it("detects when early and late effects differ beyond noise", () => {
    const novelty = classifyCohortNovelty({
      earliest: { absoluteEffect: 0.2, samplingVar: 0.0004, nControl: 40, nTreatment: 40 },
      laterPooled: { absoluteEffect: 0.01, samplingVar: 0.0004, nControl: 40, nTreatment: 40 },
      alpha: COHORT_EFFECT_NOVELTY_ALPHA,
      minArmN: COHORT_EFFECT_MIN_ARM_N,
    });
    expect(novelty.flag).toBe("detected");
    expect(novelty.p_value).toBeLessThan(COHORT_EFFECT_NOVELTY_ALPHA);
  });

  it("does not detect when early and late effects agree within noise", () => {
    const novelty = classifyCohortNovelty({
      earliest: { absoluteEffect: 0.02, samplingVar: 0.01, nControl: 40, nTreatment: 40 },
      laterPooled: { absoluteEffect: 0.021, samplingVar: 0.01, nControl: 40, nTreatment: 40 },
      alpha: COHORT_EFFECT_NOVELTY_ALPHA,
      minArmN: COHORT_EFFECT_MIN_ARM_N,
    });
    expect(novelty.flag).toBe("not_detected");
  });
});

describe("computeCohortEffect", () => {
  it("returns unavailable when decision_family has no primary Metric", () => {
    const input = cohortStatsInput(balancedEntities([0], 5, 0.1, 0.1));
    const diagnostic = computeCohortEffect({
      statsInput: { ...input, decision_family: [] },
      runStartedAt: COHORT_RUN_START,
    });
    expect(diagnostic).toEqual({ state: "unavailable", reason: "no_primary_metric" });
  });

  it("returns unavailable for ambiguous primary Metrics without pre-registration", () => {
    const input = cohortStatsInput(balancedEntities([0], 5, 0.1, 0.1));
    const diagnostic = computeCohortEffect({
      statsInput: {
        ...input,
        decision_family: [
          { metric_id: "conversion", variant: "treatment" },
          { metric_id: "revenue", variant: "treatment" },
        ],
      },
      runStartedAt: COHORT_RUN_START,
    });
    expect(diagnostic).toEqual({ state: "unavailable", reason: "ambiguous_primary_metric" });
  });

  it("estimates absolute effect per first-exposure day bucket", () => {
    // Day 0: large lift; days 1-6 and 7+: near-null. Enough n for ready buckets.
    const entities = [
      ...balancedEntities([0], 40, 0.2, 0.5),
      ...balancedEntities([3], 40, 0.2, 0.22),
      ...balancedEntities([10], 40, 0.2, 0.21),
    ];
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(entities, {
        metricConversionWindows: cohortConversionWindows(),
      }),
      runStartedAt: COHORT_RUN_START,
      analysisWatermark: COHORT_ANALYSIS_WATERMARK,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    expect(diagnostic.grouping).toBe("first_exposure_day_vs_run_start");
    expect(diagnostic.metric_id).toBe("conversion");
    const comparison = diagnostic.comparisons[0];
    if (comparison === undefined) throw new Error("expected comparison");
    expect(comparison.buckets.map((bucket) => bucket.bucket)).toEqual([
      "day_0",
      "days_1_6",
      "day_7_plus",
    ]);
    const day0 = comparison.buckets[0];
    const later = comparison.buckets[1];
    if (day0 === undefined || later === undefined) throw new Error("expected buckets");
    expect(day0.status).toBe("ready");
    expect(day0.absolute_effect).toBeGreaterThan(0.2);
    expect(later.status).toBe("ready");
    expect(comparison.novelty.flag).toBe("detected");
  });

  it("marks buckets insufficient_n below the minimum arm size", () => {
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(balancedEntities([0, 3, 10], 5, 0.2, 0.3)),
      runStartedAt: COHORT_RUN_START,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    for (const bucket of diagnostic.comparisons[0]?.buckets ?? []) {
      expect(bucket.status).toBe("insufficient_n");
      expect(bucket.absolute_effect).toBeNull();
    }
    expect(diagnostic.comparisons[0]?.novelty.flag).toBe("insufficient_data");
  });

  it("returns insufficient_data novelty when the Conversion Window is unknown", () => {
    const entities = [
      ...balancedEntities([0], 40, 0.2, 0.5),
      ...balancedEntities([3], 40, 0.2, 0.22),
    ];
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(entities),
      runStartedAt: COHORT_RUN_START,
      analysisWatermark: COHORT_ANALYSIS_WATERMARK,
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    expect(diagnostic.comparisons[0]?.novelty.flag).toBe("insufficient_data");
  });

  it("drops Entities whose Conversion Window is still open at the watermark", () => {
    const entities = [
      ...balancedEntities([0], 40, 0.2, 0.4),
      ...balancedEntities([5], 40, 0.05, 0.1),
    ];
    const diagnostic = computeCohortEffect({
      statsInput: cohortStatsInput(entities, {
        metricConversionWindows: cohortConversionWindows("conversion", 7 * 86_400_000),
      }),
      runStartedAt: COHORT_RUN_START,
      analysisWatermark: "2026-07-11T00:00:00.000Z",
      minArmN: 30,
    });
    expect(diagnostic.state).toBe("ready");
    if (diagnostic.state !== "ready") throw new Error("expected ready");
    const comparison = diagnostic.comparisons[0];
    if (comparison === undefined) throw new Error("expected comparison");
    expect(comparison.buckets[0]).toMatchObject({
      bucket: "day_0",
      n_control: 40,
      n_treatment: 40,
      status: "ready",
    });
    expect(comparison.buckets[1]).toMatchObject({
      bucket: "days_1_6",
      n_control: 0,
      n_treatment: 0,
      status: "insufficient_n",
    });
    expect(comparison.novelty.flag).toBe("insufficient_data");
  });
});
