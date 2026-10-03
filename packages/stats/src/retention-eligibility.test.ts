import { describe, expect, it } from "vitest";
import { analyzeStats } from "./stats-engine";
import type { DedupeExposureRow, PerEntityMetricRow, StatsInput } from "@splitch/contracts";
import { ANALYSIS_V1_VERSION } from "@splitch/contracts";

const ANCHOR = "2026-07-01T00:00:00.000Z";
const HORIZON_END_MS = 2 * 86_400_000;
const MATURE_WATERMARK = "2026-07-08T00:00:00.000Z";
const IMMATURE_WATERMARK = "2026-07-04T00:00:00.000Z";

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

function retentionAndBinomialInput(options: {
  data_watermark: string | undefined;
  lateAnchor: string;
}): StatsInput {
  const exposures: DedupeExposureRow[] = [
    exposure("control", "c_early", ANCHOR),
    exposure("control", "c_late", options.lateAnchor),
    exposure("treatment", "t_early", ANCHOR),
    exposure("treatment", "t_late", options.lateAnchor),
  ];
  const metric_values: PerEntityMetricRow[] = [
    metricRow("conversion", "binomial", "c_early", 1),
    metricRow("conversion", "binomial", "t_early", 1),
    metricRow("d7_retained", "retention", "c_early", 1),
    metricRow("d7_retained", "retention", "t_early", 1),
  ];
  return {
    run_id: "run_retention",
    analysis_version: ANALYSIS_V1_VERSION,
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [
      { metric_id: "conversion", variant: "treatment" },
      { metric_id: "d7_retained", variant: "treatment" },
    ],
    guardrail_decisions: [],
    metric_variance_config: [],
    ...(options.data_watermark === undefined ? {} : { data_watermark: options.data_watermark }),
    metric_retention_horizons: [
      { metric_id: "d7_retained", horizon_start_ms: 0, horizon_end_ms: HORIZON_END_MS },
    ],
    exposures,
    metric_values,
  };
}

function exposure(variant: string, targeting_key_hash: string, anchor: string): DedupeExposureRow {
  return {
    app_id: "app_1",
    targeting_key_hash,
    environment_id: "env_1",
    id_type: "user",
    run_id: "run_retention",
    variant,
    first_exposure_ts: anchor,
    window_anchor: anchor,
  };
}

function metricRow(
  metric_id: string,
  metric_type: "binomial" | "retention",
  targeting_key_hash: string,
  value: number,
): PerEntityMetricRow {
  return {
    targeting_key_hash,
    run_id: "run_retention",
    metric_id,
    metric_type,
    value,
    in_window: true,
  };
}
