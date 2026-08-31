import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentResults } from "#components/experiments/experiment-results";
import {
  breachedGuardrailStats,
  metricsFixture,
  resultsFixture,
  runFixture,
  srmFiringStats,
  statsFixture,
  underpoweredStats,
} from "./experiment-results-test-fixtures";

describe("ExperimentResults warning states", () => {
  it("keeps every Guardrail breach visible while its station is collapsed", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(breachedGuardrailStats())}
      />,
    );
    const guardrailsTrigger = (html.match(/<button[\s\S]*?<\/button>/g) ?? []).find((button) =>
      button.includes("Guardrails"),
    );
    if (!guardrailsTrigger) throw new Error("missing Guardrails station trigger");

    expect(guardrailsTrigger).toContain('aria-expanded="false"');
    expect(guardrailsTrigger).toContain("Checkout latency p95");
    expect(guardrailsTrigger).toContain("Concluding now ships a known regression");
  });

  it("never hides the numbers behind a firing SRM warning", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(srmFiringStats())}
      />,
    );

    expect(html).toContain('data-srm-tier="confirmed"');
    expect(html).toContain("Confirmed mismatch");
    // SPL-189: the PR gate's only coverage of the icon that distinguishes this
    // card from the Control-integrity card, since that proof otherwise lives
    // solely in the weekly, presently-unbootable e2e suite.
    expect(html).toContain("lucide-triangle-alert");
    // The plot and every reported number survive the warning.
    expect(html).toContain("<svg");
    expect(html).toContain("+6.4%");
    expect(html).toContain("[+1.9, +11.2]");
    expect(html).toContain("14,900");
    expect(html).toContain("10,110");
  });

  it("shows the gate's failing check without expanding a station", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(srmFiringStats())}
      />,
    );

    expect(html).toContain('data-testid="ship-blocked"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Sample Ratio Mismatch is firing");
    expect(html).toContain("Conclude Run");
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("blocks the ship action naming the underpowered Metric, numbers still shown", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(underpoweredStats())}
      />,
    );

    expect(html).toContain('data-testid="ship-blocked"');
    expect(html).toContain("Result is underpowered");
    expect(html).toContain("Checkout conversion / treatment");
    expect(html).toContain("+18.2%");
    expect(html).toContain("0.184");
  });

  it("names the Worker as the source of the refusal", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(srmFiringStats())}
      />,
    );

    expect(html).toContain("Enforced by control-plane-api");
    expect(html).toContain("never recomputes it");
  });

  it("renders whatever verdict the Worker sent, without re-deriving it", () => {
    // Statistically dirty Run, but the Worker said ship. The Panel obeys the
    // Worker: if this rendered a block, the Panel would be computing stats.
    const results = resultsFixture(srmFiringStats(), {
      gate: {
        shipAllowed: true,
        blockedBy: [],
        checks: [
          {
            id: "exposure_srm",
            status: "pass",
            title: "Exposure split matches allocation",
            detail: "Chi-square p = 0.62.",
          },
          {
            id: "activated_srm",
            status: "not_applicable",
            title: "Activated-population SRM",
            detail: "This Experiment has no activation gate.",
          },
        ],
        enforcedBy: "control-plane-api",
      },
    });
    const html = renderToStaticMarkup(
      <ExperimentResults metrics={metricsFixture()} run={runFixture()} results={results} />,
    );

    expect(html).toContain("No blocking check");
    expect(html).toContain("1 of 2 readiness checks passed");
    expect(html).not.toContain('data-testid="ship-blocked"');
  });

  /**
   * The conclude/promote mutation does not exist yet (SPL-158). An enabled
   * primary action that silently does nothing is a lie about what the Panel
   * can do, so the control stays disabled and says why.
   */
  it("never offers a live conclude action while the mutation is unbuilt", () => {
    for (const stats of [statsFixture(), srmFiringStats(), breachedGuardrailStats()]) {
      const html = renderToStaticMarkup(
        <ExperimentResults
          metrics={metricsFixture()}
          run={runFixture()}
          results={resultsFixture(stats)}
        />,
      );
      const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];
      const conclude = buttons.filter((button) => button.includes("Conclude Run"));

      expect(conclude).toHaveLength(1);
      expect(conclude[0]).toMatch(/\sdisabled=""/);
      expect(html).toContain("SPL-158");
    }
  });
});
