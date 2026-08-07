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
 * only for failed reads; healthy collecting must never look like an outage.
 * An ended Run must not be told the data plane is still catching up.
 */
describe("Experiment Results route no_data waiting state", () => {
  it("wires ExperimentResultsPanel on the Results tab with an errorComponent for real faults", () => {
    expect(resultsRoute.Route.options.component?.name).toBe("ExperimentResultsTab");
    expect(resultsRoute.Route.options.errorComponent).toBeTypeOf("function");
  });

  it("renders waiting-for-data for a running Run with no_data instead of the error page copy", () => {
    resultsData.current = resultsNoDataFixture({ missing: "metric_events", runStatus: "running" });

    const html = renderToStaticMarkup(
      <ExperimentResultsPanel
        appId="app_1"
        environmentId="env_1"
        experimentId="exp_1"
        run={runningRun()}
      />,
    );

    expect(html).toContain('data-testid="results-waiting"');
    expect(html).toContain("Run 2 · running");
    expect(html).toContain("Waiting for data");
    expect(html).toContain("Metric Events have not arrived yet");
    expect(html).not.toContain("Results unavailable");
    expect(html).not.toContain("collecting");
  });

  it("names Exposures when that is the missing input on a running Run", () => {
    resultsData.current = resultsNoDataFixture({ missing: "exposures", runStatus: "running" });

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

  it("surfaces a Control disagreement even while a Run is waiting for data", () => {
    resultsData.current = resultsNoDataFixture({
      control: {
        state: "disagreement",
        variantId: "variant_control",
        variant: "control",
        analysisVariant: "legacy_checkout",
      },
    });

    const html = renderToStaticMarkup(
      <ExperimentResultsPanel
        appId="app_1"
        environmentId="env_1"
        experimentId="exp_1"
        run={runningRun()}
      />,
    );

    expect(html).toContain("Analysis Control disagrees with the Run");
    expect(html).toContain("legacy_checkout");
    expect(html).toContain('role="alert"');
  });

  it("does not tell an ended Run that data is still arriving", () => {
    resultsData.current = resultsNoDataFixture({ missing: "metric_events", runStatus: "ended" });

    const html = renderToStaticMarkup(
      <ExperimentResultsPanel
        appId="app_1"
        environmentId="env_1"
        experimentId="exp_1"
        run={{ ...runningRun(), status: "ended", endedAt: "2026-07-20T00:00:00.000Z" }}
      />,
    );

    expect(html).toContain('data-testid="results-waiting"');
    expect(html).toContain("Run 2 · ended");
    expect(html).toContain("No data for this Run");
    expect(html).toContain("Nothing further will arrive");
    expect(html).not.toContain("Waiting for data");
    expect(html).not.toContain("will appear here once");
    expect(html).not.toContain("Results unavailable");
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
