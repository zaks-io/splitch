import { experimentSignificanceDisplays } from "@splitch/contracts";
import { cleanScenario, controlDisagreementScenario } from "@splitch/contracts/testing";
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

function readyEnvelope() {
  const { stats, gate, srm } = cleanScenario();
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
    srm,
    gate,
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
    readiness: { statistical: false, concludeExecutable: false },
    blockedBy: [],
    reasons: ["No Metric Events have been observed for this Run yet."],
    missing: "metric_events" as const,
  };
}

describe("PanelExperimentResultsOutputSchema contract pins (SPL-305)", () => {
  it("accepts decision evidence only as a complete camel-case pair", () => {
    const withEvidence = {
      ...readyEnvelope(),
      dataWatermark: "2026-09-08T12:00:00.000Z",
      resultToken: `sha256:${"a".repeat(64)}`,
    };

    expect(PanelExperimentResultsOutputSchema.safeParse(withEvidence).success).toBe(true);
    const { dataWatermark: _watermark, ...withoutWatermark } = withEvidence;
    const { resultToken: _token, ...withoutToken } = withEvidence;
    expect(PanelExperimentResultsOutputSchema.safeParse(withoutWatermark).success).toBe(false);
    expect(PanelExperimentResultsOutputSchema.safeParse(withoutToken).success).toBe(false);
  });

  it("rejects a no_run envelope that omits recommendedAction or readiness", () => {
    expect(PanelExperimentResultsOutputSchema.safeParse({ state: "no_run" }).success).toBe(false);
    expect(
      PanelExperimentResultsOutputSchema.safeParse({
        state: "no_run",
        recommendedAction: "START_A_RUN",
      }).success,
    ).toBe(false);
    expect(
      PanelExperimentResultsOutputSchema.safeParse({
        state: "no_run",
        readiness: { statistical: false, concludeExecutable: false },
        blockedBy: [],
        reasons: ["No Run has been Started for this Experiment. Call experiments_start."],
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

  it("accepts a named Analysis Control disagreement with both identities", () => {
    const { control, gate } = controlDisagreementScenario();

    expect(
      PanelExperimentResultsOutputSchema.safeParse({
        ...readyEnvelope(),
        control,
        gate,
      }).success,
    ).toBe(true);
  });
});
