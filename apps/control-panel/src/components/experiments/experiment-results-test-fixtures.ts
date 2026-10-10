import type { FrozenControlIdentity } from "@splitch/contracts";
import { experimentSignificanceDisplays } from "@splitch/contracts";
import type { ExperimentResultScenario } from "@splitch/contracts/testing";
import type {
  PanelExperimentResultsNoData,
  PanelExperimentResultsReady,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import type { ComparisonMetric } from "#lib/experiments/metric-comparison-rows";

/** The Control the fixture Run froze, resolvable unless a case overrides it. */
function frozenControl(): FrozenControlIdentity {
  return { state: "frozen", variantId: "variant_control", variant: "control" };
}

export function resultsFixture(
  scenario: ExperimentResultScenario,
  renderingOverrides: Partial<PanelExperimentResultsReady> = {},
): PanelExperimentResultsReady {
  const { dataWatermark, resultToken, ...fields } = renderingOverrides;
  const stats = renderingOverrides.stats ?? scenario.stats;
  const gate = renderingOverrides.gate ?? scenario.gate;
  const result = {
    state: "ready" as const,
    runId: "run_2",
    runNumber: 2,
    runStatus: "running" as const,
    control: scenario.control,
    readiness: { statistical: gate.shipAllowed, concludeExecutable: false },
    blockedBy: gate.blockedBy,
    reasons: [] as string[],
    stats,
    srm: scenario.srm,
    gate,
    significance: experimentSignificanceDisplays(stats),
    ...fields,
  };
  if (dataWatermark === undefined && resultToken === undefined) return result;
  if (dataWatermark === undefined || resultToken === undefined) {
    throw new Error("Incomplete fixture evidence");
  }
  return { ...result, dataWatermark, resultToken };
}

export function resultsNoDataFixture(
  overrides: Partial<PanelExperimentResultsNoData> = {},
): PanelExperimentResultsNoData {
  return {
    state: "no_data",
    runId: "run_2",
    runNumber: 2,
    runStatus: "running",
    control: frozenControl(),
    readiness: { statistical: false, concludeExecutable: false },
    blockedBy: [],
    reasons: ["No Metric Events have been observed for this Run yet."],
    missing: "metric_events",
    ...overrides,
  };
}

/** Catalog rows for the Metric ids the stats fixtures use, as the detail read returns them. */
export function metricsFixture(): ComparisonMetric[] {
  return [
    { id: "checkout_conversion", name: "Checkout conversion", kind: "binomial", direction: null },
    { id: "checkout_latency_p95", name: "Checkout latency p95", kind: "count", direction: null },
  ];
}

export function runFixture(overrides: Partial<PanelExperimentRun> = {}): PanelExperimentRun {
  return {
    id: "run_2",
    experimentId: "exp_1",
    environmentId: "env_1",
    runNumber: 2,
    status: "running",
    targetingKey: "userId",
    targetingKeyType: "user",
    activationMetricId: null,
    salt: "salt-2",
    allocation: { control: 50, treatment: 50 },
    controlVariantId: "variant_control",
    variantsJson: JSON.stringify([
      { id: "variant_control", name: "control", value: false },
      { id: "variant_treatment", name: "treatment", value: true },
    ]),
    targetingRulesJson: "[]",
    targetN: null,
    decisionFamilyJson: "[]",
    guardrailDecisionsJson: "[]",
    metricVarianceConfigJson: "[]",
    decisionMetricIds: [],
    decisionGuardrailMetricIds: [],
    confidenceLevel: 0.95,
    horizon: "sequential",
    sampleSizeLocked: null,
    configHash: "sha256:2",
    startedAt: "2026-07-19T00:00:00.000Z",
    endedAt: null,
    startReason: null,
    endReason: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}
