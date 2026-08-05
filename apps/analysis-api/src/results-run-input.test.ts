import { describe, expect, it } from "vitest";
import { materializeRunInput } from "./results-run-input";

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
