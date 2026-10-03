import { describe, expect, it } from "vitest";
import { retentionHorizonsFromQueryConfig } from "./results-retention-horizons";
import { conversionWindowsFromQueryConfig, materializeRunInput } from "./results-run-input";

function runRow(varianceConfig: unknown): Record<string, unknown> {
  return {
    run_id: "run_1",
    allocation: JSON.stringify({ control: 50, treatment: 50 }),
    control_variant: "control",
    decision_family: JSON.stringify([{ metricId: "metric_conversion" }]),
    metric_variance_config: JSON.stringify(varianceConfig),
  };
}

const currentConfig = {
  metric_id: "metric_conversion",
  winsorize: false,
  winsorize_pct: 99.9,
  cuped: true,
  cuped_coverage_threshold_pct: 70,
};

describe("materializeVarianceConfig", () => {
  it("carries a frozen config through unchanged", () => {
    expect(materializeRunInput(runRow([currentConfig])).metric_variance_config).toEqual([
      currentConfig,
    ]);
  });

  /**
   * A Run frozen before the `cuped` column existed pre-registered no CUPED
   * decision. Backfilling one would retroactively claim it did, so analysis
   * refuses the Run and the operator re-Starts it.
   */
  it("refuses a Run frozen before `cuped` existed and names the missing field", () => {
    const { cuped: _omitted, ...preCupedConfig } = currentConfig;

    expect(() => materializeRunInput(runRow([preCupedConfig]))).toThrow(
      /metric_variance_config\[0\].*cuped is missing.*re-Start the Run/s,
    );
  });

  it("names the offending entry when a later Metric is the broken one", () => {
    expect(() =>
      materializeRunInput(runRow([currentConfig, { ...currentConfig, winsorize_pct: "99.9" }])),
    ).toThrow(/metric_variance_config\[1\].*winsorize_pct must be a number, got string/s);
  });
});

describe("conversionWindowsFromQueryConfig", () => {
  it("copies frozen Conversion Windows onto StatsInput", () => {
    expect(
      conversionWindowsFromQueryConfig([
        {
          metric_id: "conversion",
          metric_type: "binomial",
          event_definition_id: "event_definition_conversion",
          event_field_name: null,
          window_duration_ms: 259_200_000,
          cuped_lookback_ms: 604_800_000,
        },
      ]),
    ).toEqual([{ metric_id: "conversion", window_duration_ms: 259_200_000 }]);
  });

  it("uses horizon_end_ms as the completeness duration for a Retention Metric", () => {
    expect(
      conversionWindowsFromQueryConfig([
        {
          metric_id: "d7",
          metric_type: "retention",
          event_definition_id: "event_definition_signup",
          event_field_name: null,
          window_offset_ms: 86_400_000,
          window_duration_ms: 86_400_000,
          horizon_start_ms: 86_400_000,
          horizon_end_ms: 172_800_000,
          cuped_lookback_ms: 604_800_000,
        },
      ]),
    ).toEqual([{ metric_id: "d7", window_duration_ms: 172_800_000 }]);
    expect(
      retentionHorizonsFromQueryConfig([
        {
          metric_id: "d7",
          metric_type: "retention",
          event_definition_id: "event_definition_signup",
          event_field_name: null,
          window_offset_ms: 86_400_000,
          window_duration_ms: 86_400_000,
          horizon_start_ms: 86_400_000,
          horizon_end_ms: 172_800_000,
          cuped_lookback_ms: 604_800_000,
        },
      ]),
    ).toEqual([{ metric_id: "d7", horizon_start_ms: 86_400_000, horizon_end_ms: 172_800_000 }]);
  });
});
