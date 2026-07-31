import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentAssignmentSnapshot } from "./experiment-assignment-snapshot";

describe("ExperimentAssignmentSnapshot", () => {
  it("renders every assignment field as frozen text with no form controls", () => {
    const html = renderToStaticMarkup(<ExperimentAssignmentSnapshot data={detail()} run={run()} />);

    expect(html).toContain("Locked · Run 3");
    expect(html).toContain("frozen for Run 3");
    expect(html).toContain("Targeting Key");
    expect(html).toContain("accountId");
    expect(html).toContain("control 60% · treatment 40%");
    expect(html).toContain("Checkout opened");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<select");
  });
});

function detail(): PanelExperimentDetailOutput {
  return {
    experiment: {
      id: "experiment_1",
      name: "Checkout",
      description: "",
      owner: "",
      tags: [],
      status: "running",
      flagId: "flag_1",
      targetingKey: "accountId",
      targetingKeyType: "account",
      activationMetricId: "metric_activation",
      conversionWindowMs: 86_400_000,
      confidenceLevel: 0.95,
      dimensions: [],
      metricIds: [],
      guardrailMetricIds: [],
      draftAllocation: null,
      draftSalt: null,
      draftTargetingRulesJson: null,
      draftSegmentIds: [],
      liveRunId: "run_3",
    },
    flag: { id: "flag_1", name: "Checkout" },
    metrics: [{ id: "metric_activation", name: "Checkout opened" }],
    variants: [
      { id: "variant_control", name: "control" },
      { id: "variant_treatment", name: "treatment" },
    ],
    runs: [run()],
  };
}

function run(): PanelExperimentRun {
  return {
    id: "run_3",
    experimentId: "experiment_1",
    environmentId: "env_1",
    runNumber: 3,
    status: "running",
    targetingKey: "accountId",
    targetingKeyType: "account",
    controlVariantId: "variant_control",
    activationMetricId: "metric_activation",
    salt: "salt-3",
    allocation: { control: 60, treatment: 40 },
    variantsJson: JSON.stringify([
      { id: "variant_control", name: "control", value: false },
      { id: "variant_treatment", name: "treatment", value: true },
    ]),
    targetingRulesJson: "[]",
    decisionMetricIds: [],
    decisionGuardrailMetricIds: [],
    confidenceLevel: 0.95,
    horizon: "sequential" as const,
    sampleSizeLocked: null,
    configHash: "sha256:three",
    startedAt: "2026-07-29T00:00:00.000Z",
    endedAt: null,
    startReason: null,
    endReason: null,
    createdAt: "2026-07-29T00:00:00.000Z",
  };
}
