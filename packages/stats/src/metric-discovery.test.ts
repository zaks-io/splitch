import { describe, expect, it } from "vitest";
import { ANALYSIS_V1_VERSION, type StatsInput } from "@splitch/contracts";
import { metricTypesById } from "./metric-discovery";

describe("metricTypesById", () => {
  it("classifies a locked Retention Metric from its frozen horizon when rows are empty", () => {
    const types = metricTypesById(
      statsInput({
        decision_family: [{ metric_id: "d7_retained", variant: "treatment" }],
        metric_retention_horizons: [
          { metric_id: "d7_retained", horizon_start_ms: 0, horizon_end_ms: 86_400_000 },
        ],
        metric_values: [],
      }),
    );
    expect(types.get("d7_retained")).toBe("retention");
  });

  it("keeps the binomial bootstrap only for locked Metrics with no horizon and no rows", () => {
    const types = metricTypesById(
      statsInput({
        decision_family: [{ metric_id: "conversion", variant: "treatment" }],
        metric_values: [],
      }),
    );
    expect(types.get("conversion")).toBe("binomial");
  });

  it("fails loud when frozen Retention conflicts with row types", () => {
    expect(() =>
      metricTypesById(
        statsInput({
          decision_family: [{ metric_id: "d7_retained", variant: "treatment" }],
          metric_retention_horizons: [
            { metric_id: "d7_retained", horizon_start_ms: 0, horizon_end_ms: 86_400_000 },
          ],
          metric_values: [
            {
              targeting_key_hash: "c_early",
              run_id: "run_retention",
              metric_id: "d7_retained",
              metric_type: "binomial",
              value: 1,
              in_window: true,
            },
          ],
        }),
      ),
    ).toThrow(/mixed retention and binomial/);
  });
});

function statsInput(overrides: Partial<StatsInput>): StatsInput {
  return {
    run_id: "run_retention",
    analysis_version: ANALYSIS_V1_VERSION,
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    guardrail_decisions: [],
    metric_variance_config: [],
    exposures: [],
    decision_family: [],
    metric_values: [],
    ...overrides,
  };
}
