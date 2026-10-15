import { z } from "zod";
import {
  type FrozenControlIdentity,
  FrozenControlIdentitySchema,
} from "../experiment-control-identity";
import {
  type DecisionGateCheck,
  type ExperimentDecisionGate,
  ExperimentDecisionGateSchema,
  type ExperimentSrmDiagnostics,
  ExperimentSrmDiagnosticsSchema,
} from "../experiment-decision-gate";
import { type StatsOutput, StatsOutputSchema } from "../stats-result-contract";
import {
  breachedGuardrailStats,
  controlDisagreementStats,
  modestLiftStats,
  srmFiringStats,
  statsFixture,
  statsWithAnalysisControl,
  underpoweredStats,
} from "./experiment-result-stats-fixtures";

export type ExperimentResultScenario = {
  stats: StatsOutput;
  control: FrozenControlIdentity;
  gate: ExperimentDecisionGate;
  srm: ExperimentSrmDiagnostics;
};

const ScenarioSchema = z
  .object({
    stats: StatsOutputSchema,
    control: FrozenControlIdentitySchema,
    gate: ExperimentDecisionGateSchema,
    srm: ExperimentSrmDiagnosticsSchema,
  })
  .strict();

const cleanGate = {
  shipAllowed: true,
  blockedBy: [],
  checks: [
    {
      id: "control_identity",
      status: "pass",
      title: "Analysis Control matches the one the Run froze",
      detail:
        'Every lift is measured against "control", the Control this Run froze at Start and Analysis reported for this read. Editing the Experiment\'s default Variant since then did not move it.',
    },
    {
      id: "exposure_srm",
      status: "pass",
      title: "Exposure split matches allocation",
      detail: "Chi-square p = 0.62, above the 0.01 caution band.",
    },
    {
      id: "activated_srm",
      status: "not_applicable",
      title: "Activated-population SRM",
      detail: "This Experiment has no activation gate, so there is no activated population.",
    },
    {
      id: "activation_balance",
      status: "not_applicable",
      title: "Per-Variant activation rate",
      detail: "This Experiment has no activation gate, so there is no activation rate to compare.",
    },
    {
      id: "engine_status",
      status: "pass",
      title: "Every decision-valid Metric returned a usable result",
      detail: "The stats engine reported no estimation error across 1 decision-valid result.",
    },
    {
      id: "underpowered",
      status: "pass",
      title: "No low-n warning",
      detail:
        "The stats engine raised no low-sample warning, and every decision-valid Metric returned a decidable result. This is an absence of a warning, not a power calculation.",
    },
    {
      id: "planned_duration",
      status: "not_applicable",
      title: "No planned duration recorded",
      detail:
        "This Run started before planned durations were recorded at Start, so there is no duration commitment to measure. None is invented for it.",
    },
    {
      id: "decision_valid_result",
      status: "pass",
      title: "A locked decision family exists",
      detail: "1 FDR-corrected goal Metric result belongs to the Run's locked decision spec.",
    },
  ],
  enforcedBy: "control-plane-api",
} satisfies ExperimentDecisionGate;

const cleanSrm = {
  exposure: {
    tier: "clean",
    pValue: 0.62,
    deviations: [
      {
        variant: "control",
        observed: 12530,
        expected: 12505,
        delta: 25,
      },
      {
        variant: "treatment",
        observed: 12480,
        expected: 12505,
        delta: -25,
      },
    ],
  },
  activated: null,
  activationBalance: null,
} satisfies ExperimentSrmDiagnostics;

function gateWithCheck(replacement: DecisionGateCheck): ExperimentDecisionGate {
  const checks = cleanGate.checks.map((check) =>
    check.id === replacement.id ? replacement : check,
  );
  const blockedBy = checks.filter((check) => check.status === "fail").map((check) => check.id);
  return { ...cleanGate, checks, blockedBy, shipAllowed: blockedBy.length === 0 };
}

function scenario(
  stats: StatsOutput,
  defaults: Partial<ExperimentResultScenario>,
  overrides: Partial<ExperimentResultScenario>,
): ExperimentResultScenario {
  return ScenarioSchema.parse({
    stats,
    control: { state: "frozen", variantId: "variant_control", variant: "control" },
    gate: cleanGate,
    srm: cleanSrm,
    ...defaults,
    ...overrides,
  });
}

export function cleanScenario(
  overrides: Partial<ExperimentResultScenario> = {},
): ExperimentResultScenario {
  return scenario(statsFixture(), {}, overrides);
}

export function analysisControlScenario(
  overrides: Partial<ExperimentResultScenario> = {},
): ExperimentResultScenario {
  return scenario(statsWithAnalysisControl(), {}, overrides);
}

export function controlDisagreementScenario(
  overrides: Partial<ExperimentResultScenario> = {},
): ExperimentResultScenario {
  return scenario(
    controlDisagreementStats(),
    {
      control: {
        state: "disagreement",
        variantId: "variant_control",
        variant: "control",
        analysisVariant: "legacy_checkout",
      },
      gate: gateWithCheck({
        id: "control_identity",
        status: "fail",
        title: "Analysis Control disagrees with the Run",
        detail:
          'This Run\'s frozen Control is "control", but the Run Snapshot measured lift against "legacy_checkout". The Run Snapshot cannot be rewritten, so no ship decision can be made for this Run. Start a new Run to get a Control that agrees across both stores.',
      }),
      srm: {
        exposure: {
          tier: "clean",
          pValue: 0.62,
          deviations: [
            {
              variant: "control",
              observed: 12480,
              expected: 12505,
              delta: -25,
            },
            {
              variant: "legacy_checkout",
              observed: 12530,
              expected: 12505,
              delta: 25,
            },
          ],
        },
        activated: null,
        activationBalance: null,
      },
    },
    overrides,
  );
}

export function unresolvableControlScenario(
  overrides: Partial<ExperimentResultScenario> = {},
): ExperimentResultScenario {
  return scenario(
    statsWithAnalysisControl(),
    {
      control: {
        state: "unresolvable",
        variantId: "variant_from_a_later_edit",
        reason: "absent_from_frozen_variant_set",
        frozenVariantNames: ["control", "treatment"],
        analysisVariant: "control",
      },
      gate: gateWithCheck({
        id: "control_identity",
        status: "fail",
        title: "Control Variant cannot be identified",
        detail:
          'This Run\'s frozen Control cannot be identified because it is absent from the Variant set this Run froze. The Run froze "control", "treatment". The Experiment\'s default Variant was backfilled onto this Run as "variant_from_a_later_edit", which the Run itself never froze. The Run Snapshot\'s Control anchors the lift, but nothing can be promoted against a Control this Run never froze. Start a new Run to get a Control that is frozen and validated.',
      }),
    },
    overrides,
  );
}

export function srmFiringScenario(
  overrides: Partial<ExperimentResultScenario> = {},
): ExperimentResultScenario {
  return scenario(
    srmFiringStats(),
    {
      gate: gateWithCheck({
        id: "exposure_srm",
        status: "fail",
        title: "Sample Ratio Mismatch is firing",
        detail:
          "Exposures are split differently than allocated (chi-square p = 0.00002). Assignment is untrustworthy, so no Variant can be called a winner. Diagnose the cause and start a new Run.",
      }),
      srm: {
        exposure: {
          tier: "confirmed",
          pValue: 2e-5,
          deviations: [
            {
              variant: "control",
              observed: 14900,
              expected: 12505,
              delta: 2395,
            },
            {
              variant: "treatment",
              observed: 10110,
              expected: 12505,
              delta: -2395,
            },
          ],
        },
        activated: null,
        activationBalance: null,
      },
    },
    overrides,
  );
}

export function underpoweredScenario(
  overrides: Partial<ExperimentResultScenario> = {},
): ExperimentResultScenario {
  return scenario(
    underpoweredStats(),
    {
      gate: gateWithCheck({
        id: "underpowered",
        status: "fail",
        title: "Result is underpowered",
        detail:
          "Not enough data to decide on checkout_conversion / treatment. Let the Run collect more Exposures.",
      }),
    },
    overrides,
  );
}

export function breachedGuardrailScenario(
  overrides: Partial<ExperimentResultScenario> = {},
): ExperimentResultScenario {
  return scenario(breachedGuardrailStats(), {}, overrides);
}

export function modestLiftScenario(
  overrides: Partial<ExperimentResultScenario> = {},
): ExperimentResultScenario {
  return scenario(modestLiftStats(), {}, overrides);
}
