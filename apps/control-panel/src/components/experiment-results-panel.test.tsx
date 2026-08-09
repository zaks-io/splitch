import type { PanelExperimentRun } from "@splitch/control-plane-sdk/panel-experiments";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  resultsFixture,
  resultsNoDataFixture,
  statsFixture,
} from "./experiment-results-test-fixtures";
import { visibleText } from "./experiment-results-test-markup";

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

    expect(alertMarkup(html)).not.toMatch(/\b(?:below|here|numbers)\b/i);
    expect(html).toContain("Analysis Control disagrees with the Run");
    expect(html).toContain(
      'This Run froze <code class="font-mono text-foreground text-xs">control</code> as its Control, but the Run Snapshot written to the analytics store at Start recorded <code class="font-mono text-foreground text-xs">legacy_checkout</code>. Both are written at Start and should match. Because they do not, results for this Run will be measured against <code class="font-mono text-foreground text-xs">legacy_checkout</code> and not against the Run&#x27;s own Control when they arrive.',
    );
    expect(html).toContain(
      "The Run Snapshot cannot be rewritten, so this Run cannot be corrected. Start a new Run to get a Control that agrees across both stores.",
    );
    expect(html).not.toContain("The numbers below remain visible for diagnosis.");
    expect(html).toContain('role="alert"');
  });

  it("surfaces an unresolvable Control without promising numbers or exposing plumbing", () => {
    resultsData.current = resultsNoDataFixture({
      control: {
        state: "unresolvable",
        variantId: "variant_from_a_later_edit",
        reason: "absent_from_frozen_variant_set",
        frozenVariantNames: ["control", "treatment"],
        analysisVariant: "control",
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

    expect(alertMarkup(html)).not.toMatch(/\b(?:below|here|numbers)\b/i);
    expect(html).toContain("Control arm cannot be identified");
    expect(html).toContain(
      "This Run&#x27;s frozen Control cannot be identified because it is absent from the Variant set this Run froze. Runs created before the Control was frozen on the Run were backfilled from the Experiment&#x27;s default Variant, which the Run itself may never have carried.",
    );
    expect(html).toContain("The Run froze");
    expect(html).toContain("control, treatment");
    expect(visibleText(alertMarkup(html))).toContain(
      "The Run Snapshot written to the analytics store at Start recorded control as the Analysis Control. Results for this Run will be measured against that Variant when they arrive.",
    );
    expect(html).toContain(
      "This Run cannot produce a ship decision. Start a new Run to get a Control that is frozen and validated.",
    );
    expect(html).not.toContain("variant_from_a_later_edit");
    expect(html).not.toContain("absent_from_frozen_variant_set");
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

function alertMarkup(html: string): string {
  const alert = html.match(/<div[^>]*role="alert"[\s\S]*?<\/div>/)?.[0];
  if (!alert) throw new Error("missing Control integrity alert");
  return alert;
}
