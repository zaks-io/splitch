import { describe, expect, it } from "vitest";
import {
  IMMATURE_WATERMARK,
  MATURE_WATERMARK,
  retentionAndBinomialInput,
} from "./retention-test-fixtures";
import { analyzeStats } from "./stats-engine";

describe("Retention Metric maturity eligibility", () => {
  it("excludes immature Entities from the Retention Metric only", async () => {
    const output = await analyzeStats(
      retentionAndBinomialInput({
        data_watermark: IMMATURE_WATERMARK,
        lateAnchor: "2026-07-03T00:00:00.000Z",
      }),
    );

    const binomial = output.arm_results.filter((arm) => arm.metric_id === "conversion");
    const retention = output.arm_results.filter((arm) => arm.metric_id === "d7_retained");
    expect(binomial.map((arm) => [arm.variant, arm.sample_size_n])).toEqual([
      ["control", 2],
      ["treatment", 2],
    ]);
    expect(output.health.deduped_counts).toEqual({ control: 2, treatment: 2 });
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

  it("counts a late Entity once the watermark reaches horizon_end", async () => {
    const output = await analyzeStats(
      retentionAndBinomialInput({
        data_watermark: MATURE_WATERMARK,
        lateAnchor: "2026-07-03T00:00:00.000Z",
      }),
    );
    const retention = output.arm_results.filter((arm) => arm.metric_id === "d7_retained");
    expect(
      retention.map((arm) => [arm.variant, arm.sample_size_n, arm.immature_excluded_n]),
    ).toEqual([
      ["control", 2, 0],
      ["treatment", 2, 0],
    ]);
  });

  it("fails loud when a Retention Metric has no watermark", async () => {
    await expect(
      analyzeStats(
        retentionAndBinomialInput({
          data_watermark: undefined,
          lateAnchor: "2026-07-03T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/data_watermark/);
  });
});
