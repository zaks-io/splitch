import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExperimentResults,
  ExperimentResultsEmpty,
} from "#components/experiments/experiment-results";
import {
  breachedGuardrailStats,
  metricsFixture,
  modestLiftStats,
  resultsFixture,
  runFixture,
  statsFixture,
} from "./experiment-results-test-fixtures";

describe("ExperimentResults", () => {
  it("renders the lift plot, the numbers and an allowed decision on a clean Run", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(statsFixture())}
      />,
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
    const html = renderToStaticMarkup(
      <ExperimentResults metrics={metricsFixture()} run={runFixture()} results={results} />,
    );

    expect(passed).toBeLessThan(results.gate.checks.length);
    expect(html).toContain(`${passed} of ${results.gate.checks.length} readiness checks passed`);
    expect(html).not.toContain("Every readiness check passed");
  });

  it("renders a realistic single-digit lift without collapsing its interval", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(modestLiftStats())}
      />,
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
          metrics={metricsFixture()}
          run={runFixture()}
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
        metrics={metricsFixture()}
        run={runFixture()}
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
    const html = renderToStaticMarkup(
      <ExperimentResults metrics={metricsFixture()} run={runFixture()} results={results} />,
    );

    expect(results.gate.shipAllowed).toBe(true);
    expect(html).toContain('data-testid="ship-guardrail-advisory"');
    expect(html).toContain("Checkout latency p95");
    expect(html).toContain("would ship a known regression");
  });

  it("tells a Run-less Experiment there is nothing to measure", () => {
    const html = renderToStaticMarkup(<ExperimentResultsEmpty />);
    expect(html).toContain("no Run yet");
  });
});

// The legend and plot must agree about where the baseline arm is, or is not,
// drawn; every case below is a way they historically disagreed.
describe("ExperimentResults baseline legend", () => {
  // The legend used to assert "at zero lift by definition" from the frozen
  // Control name alone. When no ArmResult matches that name, nothing is drawn
  // at zero, so claiming a baseline there is a lie about missing data.
  it("does not claim a baseline at zero lift when no arm matches the Control name", () => {
    const stats = statsFixture();
    expect(stats.arm_results.some((arm) => arm.variant === "control")).toBe(false);

    const html = renderToStaticMarkup(
      <ExperimentResults
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(stats)}
      />,
    );

    expect(html).toContain("Baseline (control) Variant is missing from these results");
    expect(html).not.toContain("at zero lift by definition");
    expect(html).not.toContain("0% by definition");
  });

  // Same defect under a Control name D1 never emitted as an arm (the
  // disagreement path's Analysis Control). The legend must fail loud either way.
  it("fails loud when a frozen Control name matches no drawn arm", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(statsFixture(), {
          control: {
            state: "frozen",
            variantId: "variant_analysis_control",
            variant: "analysis_control",
          },
        })}
      />,
    );

    expect(html).toContain("Baseline (analysis_control) Variant is missing from these results");
    expect(html).not.toContain("at zero lift by definition");
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
        metrics={metricsFixture()}
        run={runFixture()}
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
    const plotStart = html.indexOf('<svg aria-label="Relative lift with confidence intervals');
    if (plotStart < 0) throw new Error("missing confidence interval plot");
    const svg = html.slice(plotStart, html.indexOf("</svg>", plotStart));

    expect(svg).toContain("0% by definition");
    expect(svg).toContain("baseline, 0% lift by definition");
    expect(svg).not.toContain("−∞");
    // Legend matches what is drawn: the baseline row is present.
    expect(html).toContain("Baseline (control) at zero lift by definition");
    expect(html).not.toContain("Variant is missing from these results");
    // The table agrees with the plot: the baseline is an anchor, not a result
    // with an infinitely wide interval and a p-value of 1.
    expect(html).toContain("baseline, by definition");
    expect(html).not.toContain("[−∞, +∞]");
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
