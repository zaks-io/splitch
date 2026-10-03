import { describe, expect, it } from "vitest";
import {
  exposure,
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

  it("matures gated Retention from Activation when the Exposure row still carries first_exposure_ts as window_anchor", async () => {
    const sevenDays = 7 * 86_400_000;
    const firstExposure = "2026-07-01T00:00:00.000Z";
    const activation = "2026-07-03T00:00:00.000Z";
    const exposures = [
      exposure("control", "c_gated", firstExposure),
      exposure("treatment", "t_gated", firstExposure),
    ];
    const input = {
      ...retentionAndBinomialInput({
        data_watermark: "2026-07-09T00:00:00.000Z",
        lateAnchor: firstExposure,
      }),
      decision_family: [{ metric_id: "d7_retained", variant: "treatment" }],
      metric_retention_horizons: [
        { metric_id: "d7_retained", horizon_start_ms: 0, horizon_end_ms: sevenDays },
      ],
      exposures,
      activation_rows: [
        {
          targeting_key_hash: "c_gated",
          run_id: "run_retention",
          activation_ts: activation,
          counterfactual: false,
          activated: true,
        },
        {
          targeting_key_hash: "t_gated",
          run_id: "run_retention",
          activation_ts: activation,
          counterfactual: false,
          activated: true,
        },
      ],
      metric_values: [],
    };

    const immature = await analyzeStats(input);
    expect(
      immature.arm_results
        .filter((arm) => arm.metric_id === "d7_retained")
        .map((arm) => [arm.variant, arm.sample_size_n, arm.immature_excluded_n]),
    ).toEqual([
      ["control", 0, 1],
      ["treatment", 0, 1],
    ]);

    const mature = await analyzeStats({ ...input, data_watermark: "2026-07-10T00:00:00.000Z" });
    expect(
      mature.arm_results
        .filter((arm) => arm.metric_id === "d7_retained")
        .map((arm) => [arm.variant, arm.sample_size_n, arm.immature_excluded_n]),
    ).toEqual([
      ["control", 1, 0],
      ["treatment", 1, 0],
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
