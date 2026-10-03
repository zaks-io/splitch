import {
  evaluateExperimentDecisionGate,
  experimentSignificanceDisplays,
  experimentSrmDiagnostics,
  type StatsOutput,
} from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPanelExperimentsClient } from "./panel-experiments";

/** A legacy Run: the planned-duration check is not applicable and blocks nothing. */
const legacyDuration = {
  plannedDurationDays: null,
  overrideReason: null,
  runStartedAt: "2026-07-01T00:00:00.000Z",
  dataWatermark: null,
};

describe("panel experiment results tolerant parsing", () => {
  it("tolerates additive fields on panel experiment results through the client", async () => {
    const ready = panelResultsReady();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        ...ready,
        futureEnvelopeField: "envelope-level",
        stats: {
          ...ready.stats,
          arm_results: ready.stats.arm_results.map((arm) => ({
            ...arm,
            futureArmField: "arm-level",
          })),
        },
      }),
    );

    const result = await createPanelExperimentsClient({ fetch: fetcher }).results({
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "exp_1",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        state: "ready",
        runId: "run_1",
        stats: { arm_results: [{ variant: "treatment", sample_size_n: 500 }] },
      },
    });
    expect(JSON.stringify(result)).not.toContain("futureEnvelopeField");
    expect(JSON.stringify(result)).not.toContain("futureArmField");
  });

  it("fails loud when panel experiment results omit a required field despite additives", async () => {
    const ready = panelResultsReady();
    const { runStatus: _dropped, ...withoutRunStatus } = ready;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ...withoutRunStatus, futureEnvelopeField: true }),
    );

    await expect(
      createPanelExperimentsClient({ fetch: fetcher }).results({
        appId: "app_1",
        environmentId: "env_1",
        experimentId: "exp_1",
      }),
    ).rejects.toThrow("panel_experiment_results returned an invalid response body");
  });
});

function panelResultsReady() {
  const frozenControl = {
    state: "frozen" as const,
    variantId: "variant_control",
    variant: "control",
  };
  const stats: StatsOutput = {
    arm_results: [
      {
        variant: "treatment",
        metric_id: "conversion",
        sample_size_n: 500,
        point_estimate: 0.8,
        relative_lift_pct: 12.5,
        ci_lower: 4.1,
        ci_upper: 21.4,
        p_value: 0.002,
        is_significant: true,
        in_bh_family: true,
        exploratory: false,
        decision_valid: true,
        status: "ready",
        variance_techniques: {
          winsorized: false,
          winsorize_pct: null,
          winsorize_cap: null,
          cuped_applied: false,
          cuped_method: null,
          cuped_attribute: null,
          cuped_attribute_source: null,
          cuped_coverage_pct: null,
          delta_method: false,
        },
      },
    ],
    srm: {
      srm_p_value: 0.71,
      srm_is_mismatch: false,
      observed_counts: { control: 502, treatment: 498 },
      expected_counts: { control: 500, treatment: 500 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: [],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 502, treatment: 498 },
      deduped_counts: { control: 502, treatment: 498 },
      low_n_warning: false,
    },
  };
  const gate = evaluateExperimentDecisionGate(stats, frozenControl, legacyDuration);
  return {
    state: "ready" as const,
    runId: "run_1",
    runNumber: 1,
    runStatus: "running" as const,
    control: frozenControl,
    readiness: { statistical: gate.shipAllowed, concludeExecutable: false },
    blockedBy: gate.blockedBy,
    reasons: [],
    recommendationUnavailable: "no_pre_registration" as const,
    stats,
    srm: experimentSrmDiagnostics(stats),
    gate,
    significance: experimentSignificanceDisplays(stats),
  };
}
