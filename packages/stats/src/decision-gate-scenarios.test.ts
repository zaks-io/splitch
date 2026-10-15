import {
  analysisControlScenario,
  breachedGuardrailScenario,
  cleanScenario,
  controlDisagreementScenario,
  modestLiftScenario,
  srmFiringScenario,
  underpoweredScenario,
  unresolvableControlScenario,
} from "@splitch/contracts/testing";
import { describe, expect, it } from "vitest";
import { evaluateExperimentDecisionGate, experimentSrmDiagnostics } from "./decision-gate";

const legacyDuration = {
  plannedDurationDays: null,
  overrideReason: null,
  runStartedAt: "2026-07-01T00:00:00.000Z",
  dataWatermark: null,
};

const scenarios = {
  clean: cleanScenario,
  analysisControl: analysisControlScenario,
  controlDisagreement: controlDisagreementScenario,
  unresolvableControl: unresolvableControlScenario,
  srmFiring: srmFiringScenario,
  underpowered: underpoweredScenario,
  breachedGuardrail: breachedGuardrailScenario,
  modestLift: modestLiftScenario,
};

describe("static Experiment Results scenarios", () => {
  it.each(Object.entries(scenarios))("pins the server decisions for %s", (_name, build) => {
    const scenario = build();
    expect(
      evaluateExperimentDecisionGate(scenario.stats, scenario.control, legacyDuration),
    ).toEqual(scenario.gate);
    expect(experimentSrmDiagnostics(scenario.stats)).toEqual(scenario.srm);
  });
});
