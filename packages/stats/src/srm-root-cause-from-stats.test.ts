import type { StatsOutput } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker";
import { exposures } from "./srm-checker-test-helpers";
import { classifySrmRootCauseFromStats } from "./srm-root-cause-from-stats";

const RUN_ID = "run_srm_root_cause_from_stats";

describe("classifySrmRootCauseFromStats", () => {
  it("returns null on a clean StatsOutput", () => {
    expect(classifySrmRootCauseFromStats(statsFixture({}))).toBeNull();
  });

  it("returns triggered_only from activated mismatch with a positive Activation population", () => {
    expect(
      classifySrmRootCauseFromStats(
        statsFixture({
          srm_is_mismatch: false,
          activated_srm_mismatch: true,
          activated_srm_p_value: 0.0001,
          activation_rates: { control: 0.2, treatment: 0.6 },
          deduped_counts: { control: 500, treatment: 500 },
        }),
      ),
    ).toMatchObject({ branch: "triggered_only", nextCheck: "experiment_results_get" });
  });

  it("enrichment path: zero-Activation checker fixture stays unclassified (not triggered_only)", () => {
    // Same gated Run shape as srm-checker.test.ts "fires both activation
    // guardrails when a gated Run has no Activations".
    const checker = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...exposures("control", 120), ...exposures("treatment", 120)],
      activation_rows: [],
    });
    expect(checker.srm.srm_is_mismatch).toBe(false);
    expect(checker.srm.activated_srm_mismatch).toBe(true);
    expect(checker.health.activation_rates).toEqual({ control: 0, treatment: 0 });

    const result = classifySrmRootCauseFromStats({
      arm_results: [],
      srm: checker.srm,
      guardrail_results: [],
      health: checker.health,
    });
    expect(result?.branch).toBe("unclassified");
    expect(result?.explanation).toMatch(/insufficient evidence/i);
    expect(result?.explanation).toMatch(/zero Activations/i);
    expect(result?.evidenceConsidered).toContain("insufficient_evidence:zero_activations");
    expect(result?.evidenceConsidered).toContain("activation_count:0");
  });
});

function statsFixture(overrides: {
  srm_is_mismatch?: boolean;
  activated_srm_mismatch?: boolean | null;
  activated_srm_p_value?: number | null;
  activation_rates?: Record<string, number> | null;
  deduped_counts?: Record<string, number>;
}): StatsOutput {
  const activatedMismatch = overrides.activated_srm_mismatch ?? null;
  return {
    arm_results: [],
    srm: {
      srm_p_value: 0.5,
      srm_is_mismatch: overrides.srm_is_mismatch ?? false,
      observed_counts: { control: 100, treatment: 100 },
      expected_counts: { control: 100, treatment: 100 },
      activated_srm_p_value: overrides.activated_srm_p_value ?? null,
      activated_srm_mismatch: activatedMismatch,
    },
    guardrail_results: [],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates:
        overrides.activation_rates !== undefined
          ? overrides.activation_rates
          : activatedMismatch === null
            ? null
            : { control: 0.5, treatment: 0.5 },
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: overrides.deduped_counts ?? { control: 100, treatment: 100 },
      deduped_counts: overrides.deduped_counts ?? { control: 100, treatment: 100 },
      low_n_warning: false,
    },
  };
}
