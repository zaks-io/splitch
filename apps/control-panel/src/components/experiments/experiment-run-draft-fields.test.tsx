import type { PanelExperimentDetailOutput } from "@splitch/control-plane-sdk/panel-experiments";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentRunDraftFields } from "#components/experiments/experiment-run-draft-fields";
import { useRunDraftState } from "#lib/experiments/experiment-run-draft-state";

describe("ExperimentRunDraftFields", () => {
  it("renders the Horizon label instead of its stored value", () => {
    const html = renderToStaticMarkup(<Harness />);

    expect(html).toMatch(
      /data-slot="select-value"[^>]*>Sequential \(always-valid, peek any time\)<\/span>/u,
    );
    expect(html).not.toMatch(/data-slot="select-value"[^>]*>sequential<\/span>/u);
  });
});

function Harness() {
  const data = experimentDetail();
  const state = useRunDraftState(data, undefined);
  return (
    <ExperimentRunDraftFields data={data} hasRunningRun={false} idPrefix="test-run" state={state} />
  );
}

function experimentDetail(): PanelExperimentDetailOutput {
  return {
    experiment: {
      id: "experiment_1",
      key: "checkout-copy",
      name: "Checkout Copy",
      description: "",
      owner: "",
      tags: [],
      status: "draft",
      flagId: "flag_1",
      targetingKey: "userId",
      targetingKeyType: "user",
      activationMetricId: null,
      conversionWindowMs: 0,
      confidenceLevel: 0.95,
      dimensions: [],
      metricIds: [],
      guardrailMetricIds: [],
      draftAllocation: { control: 50, treatment: 50 },
      draftSalt: null,
      draftTargetingRulesJson: "[]",
      draftSegmentIds: [],
      liveRunId: null,
    },
    flag: { id: "flag_1", key: "new-checkout", name: "New Checkout" },
    metrics: [],
    eventDefinitions: [],
    variants: [
      { id: "variant_control", name: "control" },
      { id: "variant_treatment", name: "treatment" },
    ],
    runs: [],
  };
}
