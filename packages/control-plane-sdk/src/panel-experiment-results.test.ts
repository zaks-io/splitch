import {
  evaluateExperimentDecisionGate,
  experimentSignificanceDisplays,
  experimentSrmDiagnostics,
  type StatsOutput,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { PanelExperimentResultsOutputSchema } from "./panel-experiment-results";

/**
 * Contract pins for the Panel Results envelope (SPL-305 review).
 *
 * Handler tests alone leave these soft: making `recommendedAction` optional or
 * `runStatus` optional on ready/no_data still passes the broader suites. Assert
 * them here so a future `.optional()` / `.default()` fails at the schema layer.
 */

const frozenControl = {
  state: "frozen" as const,
  variantId: "variant_control",
  variant: "control",
};

function statsOutput(): StatsOutput {
  return {
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
}

function readyEnvelope() {
  const stats = statsOutput();
  return {
    state: "ready" as const,
    runId: "run_1",
    runNumber: 1,
    runStatus: "running" as const,
    control: frozenControl,
    stats,
    srm: experimentSrmDiagnostics(stats),
    gate: evaluateExperimentDecisionGate(stats, frozenControl),
    significance: experimentSignificanceDisplays(stats),
  };
}

function noDataEnvelope() {
  return {
    state: "no_data" as const,
    runId: "run_1",
    runNumber: 1,
    runStatus: "running" as const,
    control: frozenControl,
    missing: "metric_events" as const,
  };
}

describe("PanelExperimentResultsOutputSchema contract pins (SPL-305)", () => {
  it("rejects a no_run envelope that omits recommendedAction", () => {
    expect(PanelExperimentResultsOutputSchema.safeParse({ state: "no_run" }).success).toBe(false);
    expect(
      PanelExperimentResultsOutputSchema.safeParse({
        state: "no_run",
        recommendedAction: "START_A_RUN",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["ready", readyEnvelope],
    ["no_data", noDataEnvelope],
  ] as const)("requires runStatus on the %s member", (_state, build) => {
    const base = build();
    expect(PanelExperimentResultsOutputSchema.safeParse(base).success).toBe(true);

    const { runStatus: _dropped, ...withoutRunStatus } = base;
    expect(PanelExperimentResultsOutputSchema.safeParse(withoutRunStatus).success).toBe(false);
  });
});
