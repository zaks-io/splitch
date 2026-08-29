import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentDetail, ExperimentTabStub } from "./experiment-detail";

describe("ExperimentDetail", () => {
  it("renders Run history above tabs and preserves the active tab in Run links", () => {
    const html = renderToStaticMarkup(
      <ExperimentDetail
        activeTab="setup"
        data={detail()}
        scope={{ orgSlug: "acme", appSlug: "checkout", env: "dev" }}
        selectedRunId="run_1"
      >
        <ExperimentTabStub run={run(1)} tab="setup" />
      </ExperimentDetail>,
    );

    expect(html.indexOf("Run history")).toBeLessThan(html.indexOf("Experiment detail tabs"));
    expect(html.indexOf("Run 2")).toBeLessThan(html.indexOf("Run 1"));
    expect(html).toContain("Allocation 50%/50% → 70%/30%");
    expect(html).toContain("Note: Increase treatment traffic");
    expect(html).toContain("End note: Prepared a larger treatment allocation");
    expect(html).toContain('href="/acme/checkout/dev/experiments/experiment_1/runs/run_2/setup"');
    expect(html).toContain('href="/acme/checkout/dev/experiments/experiment_1/runs/run_1/results"');
  });

  it("teaches a draft with no Run that its first landing is Setup", () => {
    const data = detail({
      experiment: {
        ...experiment(),
        id: "experiment_draft",
        name: "Draft Experiment",
        status: "draft",
        liveRunId: null,
      },
      runs: [],
    });
    const html = renderToStaticMarkup(
      <ExperimentDetail
        activeTab="setup"
        data={data}
        scope={{ orgSlug: "acme", appSlug: "checkout", env: "dev" }}
      >
        <ExperimentTabStub run={undefined} tab="setup" />
      </ExperimentDetail>,
    );

    expect(html).toContain("No Runs yet");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("The frozen assignment configuration for this draft");
  });
});

function detail(overrides: Partial<PanelExperimentDetailOutput> = {}): PanelExperimentDetailOutput {
  return {
    experiment: experiment(),
    flag: { id: "flag_1", key: "new-checkout", name: "New Checkout" },
    metrics: [],
    eventDefinitions: [],
    variants: [
      { id: "variant_control", name: "control" },
      { id: "variant_treatment", name: "treatment" },
    ],
    runs: [run(2), run(1)],
    ...overrides,
  };
}

function experiment(): PanelExperimentDetailOutput["experiment"] {
  return {
    id: "experiment_1",
    name: "Checkout Copy",
    description: "",
    owner: "",
    tags: [],
    status: "running",
    flagId: "flag_1",
    targetingKey: "userId",
    targetingKeyType: "user",
    activationMetricId: null,
    conversionWindowMs: 0,
    confidenceLevel: 0.95,
    dimensions: [],
    metricIds: [],
    guardrailMetricIds: [],
    draftAllocation: null,
    draftSalt: null,
    draftTargetingRulesJson: null,
    draftSegmentIds: [],
    liveRunId: "run_2",
  };
}

function run(runNumber: 1 | 2): PanelExperimentRun {
  const latest = runNumber === 2;
  return {
    id: `run_${runNumber}`,
    experimentId: "experiment_1",
    environmentId: "env_1",
    runNumber,
    status: latest ? "running" : "ended",
    targetingKey: "userId",
    targetingKeyType: "user",
    activationMetricId: null,
    salt: `salt-${runNumber}`,
    allocation: latest ? { control: 70, treatment: 30 } : { control: 50, treatment: 50 },
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
    horizon: "sequential" as const,
    sampleSizeLocked: null,
    configHash: `sha256:${runNumber}`,
    startedAt: latest ? "2026-07-19T00:00:00.000Z" : "2026-07-18T00:00:00.000Z",
    endedAt: latest ? null : "2026-07-18T23:00:00.000Z",
    startReason: latest ? "Increase treatment traffic" : null,
    endReason: latest ? null : "Prepared a larger treatment allocation",
    createdAt: latest ? "2026-07-19T00:00:00.000Z" : "2026-07-18T00:00:00.000Z",
  };
}
