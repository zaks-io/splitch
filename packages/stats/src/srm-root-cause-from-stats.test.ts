import type { StatsOutput } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { classifySrmRootCauseFromStats } from "./srm-root-cause-from-stats";

describe("classifySrmRootCauseFromStats", () => {
  it("returns null on a clean StatsOutput", () => {
    expect(classifySrmRootCauseFromStats(statsFixture({}))).toBeNull();
  });

  it("returns triggered_only from activated mismatch alone", () => {
    expect(
      classifySrmRootCauseFromStats(
        statsFixture({
          srm_is_mismatch: false,
          activated_srm_mismatch: true,
          activated_srm_p_value: 0.0001,
        }),
      ),
    ).toMatchObject({ branch: "triggered_only", nextCheck: "experiment_results_get" });
  });
});

function statsFixture(overrides: {
  srm_is_mismatch?: boolean;
  activated_srm_mismatch?: boolean | null;
  activated_srm_p_value?: number | null;
}): StatsOutput {
  return {
    arm_results: [],
    srm: {
      srm_p_value: 0.5,
      srm_is_mismatch: overrides.srm_is_mismatch ?? false,
      observed_counts: { control: 100, treatment: 100 },
      expected_counts: { control: 100, treatment: 100 },
      activated_srm_p_value: overrides.activated_srm_p_value ?? null,
      activated_srm_mismatch: overrides.activated_srm_mismatch ?? null,
    },
    guardrail_results: [],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 100, treatment: 100 },
      deduped_counts: { control: 100, treatment: 100 },
      low_n_warning: false,
    },
  };
}
