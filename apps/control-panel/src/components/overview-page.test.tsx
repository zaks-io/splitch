import type { AppOverviewResponse } from "@splitch/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewPage } from "./overview-page";

const SCOPE_HREF = "/acme-labs/checkout-api/production";

const ENVIRONMENT: AppOverviewResponse["environment"] = {
  id: "env_prod",
  key: "production",
  name: "Production",
  policy: {
    variantAvailability: "confirm",
    targetingRolloutValue: "confirm",
    enabledState: "allow",
    startExperimentRun: "confirm",
  },
};

function render(overrides: Partial<AppOverviewResponse>): string {
  const overview: AppOverviewResponse = {
    appId: "app_checkout",
    environmentId: "env_prod",
    experiments: { status: "ok", needingDecision: [], failing: [] },
    flagConfiguration: { recentlyChanged: [], windowDays: 7 },
    environment: ENVIRONMENT,
    ...overrides,
  };
  return renderToStaticMarkup(
    <OverviewPage
      env="production"
      onRetry={() => undefined}
      overview={overview}
      scopeHref={SCOPE_HREF}
    />,
  );
}

describe("Overview page", () => {
  it("shows the calm state only when every section was read and is empty", () => {
    expect(render({})).toContain("Nothing needs your attention");
  });

  it("never shows the calm state when a section could not be read", () => {
    const html = render({
      experiments: { status: "unavailable", reason: "analysis_unavailable", retryable: true },
    });

    expect(html).not.toContain("Nothing needs your attention");
    expect(html).toContain("Experiment attention is unknown");
    expect(html).toContain("Retry");
  });

  it("does not offer a retry for a fault no retry repairs", () => {
    const html = render({
      experiments: { status: "unavailable", reason: "experiment_integrity", retryable: false },
    });

    expect(html).toContain("Refreshing will not clear this");
    expect(html).not.toContain(">Retry<");
  });

  it("does not offer a retry when the read budget is blown", () => {
    const html = render({
      experiments: { status: "unavailable", reason: "read_budget_exceeded", retryable: false },
    });

    expect(html).toContain("Refreshing will not clear this");
    expect(html).not.toContain(">Retry<");
  });

  it("links each Experiment needing a decision to its Run results", () => {
    const html = render({
      experiments: {
        status: "ok",
        needingDecision: [
          {
            id: "exp_checkout",
            name: "Checkout redesign",
            runId: "run_live",
            reasons: ["significance_reached", "horizon_reached"],
          },
        ],
        failing: [],
      },
    });

    expect(html).toContain(`href="${SCOPE_HREF}/experiments/exp_checkout/results"`);
    expect(html).toContain("Significance reached");
    expect(html).toContain("Horizon reached");
  });

  it("names every failure reason on a failing Run", () => {
    const html = render({
      experiments: {
        status: "ok",
        needingDecision: [],
        failing: [
          {
            id: "exp_search",
            name: "Search ranking",
            runId: "run_search",
            reasons: ["srm_firing", "multiple_assignment_quarantine"],
          },
        ],
      },
    });

    expect(html).toContain("SRM firing");
    expect(html).toContain("Multiple assignment");
  });

  it("links a recently changed Flag Configuration by key and admits it has no actor", () => {
    const html = render({
      flagConfiguration: {
        windowDays: 7,
        recentlyChanged: [
          {
            flagId: "flag_checkout",
            flagKey: "checkout-redesign",
            flagName: "Checkout redesign",
            enabled: true,
            updatedAt: "2026-07-19T10:00:00.000Z",
          },
        ],
      },
    });

    expect(html).toContain(`href="${SCOPE_HREF}/flags/checkout-redesign"`);
    expect(html).toContain("Who made each change is not recorded yet");
    // The machine-readable value stays exact; the visible one is UTC, because a
    // locale- or clock-relative label would disagree between server and client.
    expect(html).toContain('dateTime="2026-07-19T10:00:00.000Z"');
    expect(html).toContain("19 Jul 2026, 10:00 UTC");
  });

  it("renders the Environment policy posture per write", () => {
    const html = render({});

    expect(html).toContain("Enable / disable a Flag");
    expect(html).toContain("Start an Experiment Run");
    expect(html).toContain(`href="${SCOPE_HREF}/settings"`);
  });
});
