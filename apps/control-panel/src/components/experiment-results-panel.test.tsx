import type { PanelExperimentRun } from "@splitch/control-plane-sdk/panel-experiments";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  resultsFixture,
  resultsNoDataFixture,
  statsFixture,
} from "./experiment-results-test-fixtures";

const resultsData = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("#lib/experiments-query", () => ({
  experimentResultsQuery: () => ({}),
}));

vi.mock("@tanstack/react-query", () => ({
  useSuspenseQuery: () => {
    if (resultsData.current == null) {
      throw new Error("resultsData.current must be set before render");
    }
    return { data: resultsData.current };
  },
}));

const { ExperimentResultsPanel } = await import("./experiment-results-panel");
const resultsRoute = await import(
  "../routes/$orgSlug.$appSlug.$env.experiments.$experimentId.results"
);

/**
 * Route-facing Results seam (SPL-302): early-Run `no_data` must render the
 * waiting state through ExperimentResultsPanel. The route errorComponent is
 * only for failed reads — healthy collecting must never look like an outage.
 */
describe("Experiment Results route — no_data waiting state", () => {
  it("wires ExperimentResultsPanel on the Results tab with an errorComponent for real faults", () => {
    expect(resultsRoute.Route.options.component?.name).toBe("ExperimentResultsTab");
    expect(resultsRoute.Route.options.errorComponent).toBeTypeOf("function");
  });

  it("renders waiting-for-data for Analysis no_data instead of the error page copy", () => {
    resultsData.current = resultsNoDataFixture({ missing: "metric_events" });

    const html = renderToStaticMarkup(
      <ExperimentResultsPanel
        appId="app_1"
        environmentId="env_1"
        experimentId="exp_1"
        run={runningRun()}
      />,
    );

    expect(html).toContain('data-testid="results-waiting"');
    expect(html).toContain("Waiting for data");
    expect(html).toContain("Metric Events have not arrived yet");
    expect(html).not.toContain("Results unavailable");
  });

  it("names Exposures when that is the missing input", () => {
    resultsData.current = resultsNoDataFixture({ missing: "exposures" });

    const html = renderToStaticMarkup(
      <ExperimentResultsPanel
        appId="app_1"
        environmentId="env_1"
        experimentId="exp_1"
        run={runningRun()}
      />,
    );

    expect(html).toContain("Exposures have not arrived for this Run yet");
  });

  it("still renders measured Results when Analysis answers ready", () => {
    resultsData.current = resultsFixture(statsFixture());

    const html = renderToStaticMarkup(
      <ExperimentResultsPanel
        appId="app_1"
        environmentId="env_1"
        experimentId="exp_1"
        run={runningRun()}
      />,
    );

    expect(html).toContain("+6.4%");
    expect(html).not.toContain('data-testid="results-waiting"');
  });
});

function runningRun(): PanelExperimentRun {
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
    variantsJson: "[]",
    targetingRulesJson: "[]",
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
  };
}
