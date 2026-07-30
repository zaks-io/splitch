import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentResults, ExperimentResultsEmpty } from "./experiment-results";
import {
  breachedGuardrailStats,
  modestLiftStats,
  resultsFixture,
  srmFiringStats,
  statsFixture,
  underpoweredStats,
} from "./experiment-results-test-fixtures";

describe("ExperimentResults", () => {
  it("renders the lift plot, the numbers and an allowed decision on a clean Run", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults results={resultsFixture(statsFixture())} />,
    );

    expect(html).toContain("+6.4%");
    expect(html).toContain("[+1.9, +11.2]");
    expect(html).toContain("<svg");
    expect(html).toContain("No blocking check");
    expect(html).not.toContain('data-testid="ship-blocked"');
  });

  // "Every readiness check passed" claims a pass for checks that only reported
  // not-applicable. The count has to match what was actually assessed.
  it("counts the checks that passed instead of claiming they all did", () => {
    const results = resultsFixture(statsFixture());
    const passed = results.gate.checks.filter((check) => check.status === "pass").length;
    const html = renderToStaticMarkup(<ExperimentResults results={results} />);

    expect(passed).toBeLessThan(results.gate.checks.length);
    expect(html).toContain(`${passed} of ${results.gate.checks.length} readiness checks passed`);
    expect(html).not.toContain("Every readiness check passed");
  });

  it("renders a realistic single-digit lift without collapsing its interval", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults results={resultsFixture(modestLiftStats())} />,
    );

    expect(html).toContain("+2.4%");
    expect(html).toContain("[+0.6, +4.2]");
    expect(html).toContain("0.0092");
  });

  // 0.0499 and 0.0501 fall on opposite sides of a conventional alpha and must
  // never print as the same number.
  it("keeps p-values distinguishable across a decision boundary", () => {
    const base = statsFixture();
    const [arm] = base.arm_results;
    if (!arm) throw new Error("fixture must produce an arm");
    const render = (pValue: number) =>
      renderToStaticMarkup(
        <ExperimentResults
          results={resultsFixture({ ...base, arm_results: [{ ...arm, p_value: pValue }] })}
        />,
      );

    expect(render(0.0499)).toContain("0.0499");
    expect(render(0.0501)).toContain("0.0501");
  });

  // ADR-0014: the interval a reader sees must be the interval the call was made
  // on. When they disagree, saying so beats picking the flattering one.
  it("refuses to call a result significant when the interval shown spans zero", () => {
    const base = statsFixture();
    const [arm] = base.arm_results;
    if (!arm) throw new Error("fixture must produce an arm");
    const html = renderToStaticMarkup(
      <ExperimentResults
        results={resultsFixture({
          ...base,
          arm_results: [{ ...arm, ci_lower: -2036.6, ci_upper: 5036.6, is_significant: true }],
        })}
      />,
    );

    expect(html).toContain("Significance disputed");
    expect(html).not.toContain(">Significant<");
  });

  // Guardrails deliberately do not gate, which makes a breach beside an
  // otherwise clean gate the most misleading state the tab can reach.
  it("names a breached Guardrail in the ship decision without blocking on it", () => {
    const results = resultsFixture(breachedGuardrailStats());
    const html = renderToStaticMarkup(<ExperimentResults results={results} />);

    expect(results.gate.shipAllowed).toBe(true);
    expect(html).toContain('data-testid="ship-guardrail-advisory"');
    expect(html).toContain("checkout_latency_p95");
    expect(html).toContain("would ship a known regression");
  });

  // The Worker reports no lift for the baseline arm. Drawn as an interval that
  // would render as an unbounded whisker spanning the plot, claiming total
  // uncertainty about the one quantity here that is exact.
  it("anchors the baseline arm at zero instead of drawing it as an open interval", () => {
    const stats = statsFixture();
    const [treatment] = stats.arm_results;
    if (!treatment) throw new Error("fixture must produce a treatment arm");
    const html = renderToStaticMarkup(
      <ExperimentResults
        results={resultsFixture({
          ...stats,
          arm_results: [
            {
              ...treatment,
              variant: "control",
              relative_lift_pct: null,
              ci_lower: null,
              ci_upper: null,
              in_bh_family: false,
              is_significant: false,
            },
            treatment,
          ],
        })}
      />,
    );
    const svg = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));

    expect(svg).toContain("0% by definition");
    expect(svg).toContain("baseline, 0% lift by definition");
    expect(svg).not.toContain("−∞");
    // The table agrees with the plot: the baseline is an anchor, not a result
    // with an infinitely wide interval and a p-value of 1.
    expect(html).toContain("baseline, by definition");
    expect(html).not.toContain("[−∞, +∞]");
  });

  it("tells a Run-less Experiment there is nothing to measure", () => {
    const html = renderToStaticMarkup(<ExperimentResultsEmpty />);
    expect(html).toContain("no Run yet");
  });
});

describe("ExperimentResults warning states", () => {
  it("never hides the numbers behind a firing SRM warning", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults results={resultsFixture(srmFiringStats())} />,
    );

    expect(html).toContain('data-srm-tier="confirmed"');
    expect(html).toContain("Confirmed mismatch");
    // The plot and every reported number survive the warning.
    expect(html).toContain("<svg");
    expect(html).toContain("+6.4%");
    expect(html).toContain("[+1.9, +11.2]");
    expect(html).toContain("14,900");
    expect(html).toContain("10,110");
  });

  it("blocks the ship action naming the failing SRM check", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults results={resultsFixture(srmFiringStats())} />,
    );

    expect(html).toContain('data-testid="ship-blocked"');
    expect(html).toContain("Sample Ratio Mismatch is firing");
    expect(html).toContain("Conclude and promote winner");
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("blocks the ship action naming the underpowered Metric, numbers still shown", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults results={resultsFixture(underpoweredStats())} />,
    );

    expect(html).toContain('data-testid="ship-blocked"');
    expect(html).toContain("Result is underpowered");
    expect(html).toContain("checkout_conversion / treatment");
    expect(html).toContain("+18.2%");
    expect(html).toContain("0.184");
  });

  it("names the Worker as the source of the refusal", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults results={resultsFixture(srmFiringStats())} />,
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
    const html = renderToStaticMarkup(<ExperimentResults results={results} />);

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
      const html = renderToStaticMarkup(<ExperimentResults results={resultsFixture(stats)} />);
      const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];

      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toContain("Conclude and promote winner");
      expect(buttons[0]).toMatch(/\sdisabled=""/);
      expect(html).toContain("SPL-158");
    }
  });
});

describe("Results tab source", () => {
  const sources = resultsSources();

  it("offers no way to ship past the gate", () => {
    for (const [name, source] of sources) {
      if (name.includes("test")) continue;
      expect(`${name}: ${source.toLowerCase()}`).not.toMatch(
        /ship anyway|override|force ship|ignore warning|proceed anyway|acknowledge and/,
      );
    }
  });

  it("never evaluates the gate in the browser", () => {
    for (const [name, source] of sources) {
      if (name.includes("test")) continue;
      expect(`${name}: ${source}`).not.toContain("evaluateExperimentDecisionGate");
    }
  });
});

function resultsSources(): [string, string][] {
  const dir = join(import.meta.dirname, ".");
  return readdirSync(dir)
    .filter((file) => file.startsWith("experiment-results"))
    .map((file) => [file, stripComments(readFileSync(join(dir, file), "utf8"))]);
}

/** Prose about the absence of a bypass must not read as the presence of one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
