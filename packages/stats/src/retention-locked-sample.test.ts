import { describe, expect, it } from "vitest";
import {
  ANCHOR,
  emptyRetentionRowsInput,
  exposure,
  IMMATURE_WATERMARK,
  retentionAndBinomialInput,
  staggeredActivationInput,
} from "./retention-test-fixtures";
import { analyzeStats } from "./stats-engine";

describe("Retention Metric discovery and locked sample", () => {
  it("omits eligibility fields on existing Metric kinds", async () => {
    const output = await analyzeStats(
      retentionAndBinomialInput({
        data_watermark: IMMATURE_WATERMARK,
        lateAnchor: "2026-07-03T00:00:00.000Z",
      }),
    );
    const binomial = output.arm_results.filter((arm) => arm.metric_id === "conversion");
    expect(binomial.length).toBeGreaterThan(0);
    for (const arm of binomial) {
      expect("eligible_n" in arm).toBe(false);
      expect("immature_excluded_n" in arm).toBe(false);
    }
  });

  it("preserves eligibility fields on a Retention Dimension slice", async () => {
    const output = await analyzeStats({
      ...retentionAndBinomialInput({
        data_watermark: IMMATURE_WATERMARK,
        lateAnchor: "2026-07-03T00:00:00.000Z",
      }),
      exposures: [
        { ...exposure("control", "c_early", ANCHOR), dimension_values: { country: "US" } },
        {
          ...exposure("control", "c_late", "2026-07-03T00:00:00.000Z"),
          dimension_values: { country: "US" },
        },
        { ...exposure("treatment", "t_early", ANCHOR), dimension_values: { country: "US" } },
        {
          ...exposure("treatment", "t_late", "2026-07-03T00:00:00.000Z"),
          dimension_values: { country: "US" },
        },
      ],
      dimensions: [{ dimension_id: "country", class: "secondary", values: ["US"] }],
    });
    const slice = output.dimension_results?.find(
      (dimension) => dimension.dimension_id === "country" && dimension.dimension_value === "US",
    );
    const retention = slice?.arm_results.filter((arm) => arm.metric_id === "d7_retained") ?? [];
    expect(retention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variant: "control",
          eligible_n: 1,
          immature_excluded_n: 1,
        }),
        expect.objectContaining({
          variant: "treatment",
          eligible_n: 1,
          immature_excluded_n: 1,
        }),
      ]),
    );
  });

  it("locks the first-N population before maturity across successive watermarks", async () => {
    const early = await analyzeStats(staggeredActivationInput("2026-07-04T00:00:00.000Z"));
    const later = await analyzeStats(staggeredActivationInput("2026-07-08T00:00:00.000Z"));
    const earlyControl = early.arm_results.find(
      (arm) => arm.metric_id === "d7_retained" && arm.variant === "control",
    );
    const laterControl = later.arm_results.find(
      (arm) => arm.metric_id === "d7_retained" && arm.variant === "control",
    );
    expect(earlyControl).toMatchObject({
      sample_size_n: 0,
      eligible_n: 0,
      immature_excluded_n: 1,
    });
    expect(laterControl).toMatchObject({
      sample_size_n: 1,
      eligible_n: 1,
      immature_excluded_n: 0,
    });
  });

  it("discovers Retention from a frozen horizon when rows are empty", async () => {
    const output = await analyzeStats(emptyRetentionRowsInput(IMMATURE_WATERMARK));
    const retention = output.arm_results.filter((arm) => arm.metric_id === "d7_retained");
    expect(retention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variant: "control",
          sample_size_n: 1,
          eligible_n: 1,
          immature_excluded_n: 1,
        }),
        expect.objectContaining({
          variant: "treatment",
          sample_size_n: 1,
          eligible_n: 1,
          immature_excluded_n: 1,
        }),
      ]),
    );
  });

  it("fails loud when empty Retention rows have no watermark", async () => {
    await expect(analyzeStats(emptyRetentionRowsInput(undefined))).rejects.toThrow(
      /data_watermark/,
    );
  });
});
