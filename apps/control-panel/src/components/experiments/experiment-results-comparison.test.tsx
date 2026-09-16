import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentResultsComparisonValue } from "./experiment-results-comparison-value";
import { ExperimentResultsComparison } from "./experiment-results-comparison";
import {
  resultsFixture,
  runFixture,
  statsWithAnalysisControl,
} from "./experiment-results-test-fixtures";
import { visibleText } from "./experiment-results-test-markup";

function renderComparison(
  options: { zero?: boolean; missing?: boolean; empty?: boolean; ratio?: boolean } = {},
) {
  const stats = statsWithAnalysisControl();
  stats.arm_results = stats.arm_results.map((arm) => ({
    ...arm,
    point_estimate: options.zero ? 0 : arm.variant === "control" ? 0.0167 : 0.0577,
    sample_size_n: options.empty ? 0 : 14,
    is_significant: false,
    status: options.ratio ? "insufficient_denominator" : "insufficient_n",
  }));
  if (options.missing)
    stats.arm_results = stats.arm_results.filter((arm) => arm.variant === "control");
  return renderToStaticMarkup(
    <ExperimentResultsComparison
      results={resultsFixture(stats)}
      run={runFixture({ decisionMetricIds: ["checkout_conversion", "missing_metric"] })}
      metrics={[
        {
          id: "checkout_conversion",
          name: "Error rate",
          kind: options.ratio ? "ratio" : "binomial",
        },
        { id: "missing_metric", name: "Feedback coverage", kind: "ratio" },
        { id: "unrelated", name: "Unrelated App Metric", kind: "count" },
      ]}
      baseline="control"
      variantOrder={["treatment", "control"]}
    />,
  );
}

describe("ExperimentResultsComparison", () => {
  it("shows inconclusive estimates with absolute percentage-point differences and baseline first", () => {
    const html = renderComparison();
    const text = visibleText(html);
    expect(text).toContain("1.67%");
    expect(text).toContain("5.77%");
    expect(text).toContain("+4.1 pp");
    expect(text.indexOf("Baseline")).toBeLessThan(text.indexOf("treatment"));
    expect(text).toContain("Data freshness unavailable");
    expect(html).not.toContain("accordion");
  });

  it("keeps configured missing metrics without including unrelated App metrics", () => {
    const text = visibleText(renderComparison({ missing: true }));
    expect(text).toContain("Feedback coverage");
    expect(text).toContain("No analysis result returned");
    expect(text).not.toContain("Unrelated App Metric");
    expect(text).not.toContain("+4.1 pp");
  });

  it("preserves measured zero rates but does not turn missing observations into zero", () => {
    expect(visibleText(renderComparison({ zero: true }))).toContain("0%");
    const text = visibleText(renderComparison({ zero: true, empty: true }));
    expect(text).toContain("No observations yet");
    expect(text).not.toContain("0%");
  });

  it("does not present an unavailable ratio estimate as zero", () => {
    const text = visibleText(renderComparison({ zero: true, ratio: true }));
    expect(text).toContain("Estimate unresolved: insufficient denominator");
    expect(text).not.toMatch(/\b0\b/);
  });
  it("retains frozen exploratory metrics and supports several treatments in recorded units", () => {
    const stats = statsWithAnalysisControl();
    const template = stats.arm_results[0];
    if (!template) throw new Error("Missing fixture arm");
    stats.arm_results = [
      { ...template, variant: "control", point_estimate: 34.92 },
      { ...template, variant: "fast", point_estimate: 23.19 },
      { ...template, variant: "slow", point_estimate: 40 },
    ];
    const html = renderToStaticMarkup(
      <ExperimentResultsComparison
        results={resultsFixture(stats, {
          dataWatermark: "2026-09-16T12:00:00Z",
          resultToken: `sha256:${"a".repeat(64)}`,
        })}
        run={runFixture({
          metricVarianceConfigJson: JSON.stringify([
            {
              metric_id: "frozen",
              winsorize: false,
              winsorize_pct: 1,
              cuped: false,
              cuped_coverage_threshold_pct: 50,
            },
          ]),
        })}
        metrics={[
          { id: "checkout_conversion", name: "Duration", kind: "ratio" },
          { id: "frozen", name: "Frozen exploratory Metric", kind: "count" },
        ]}
        baseline="control"
        variantOrder={["control", "fast", "slow"]}
      />,
    );
    const text = visibleText(html);
    expect(text).toContain("-11.73");
    expect(text).toContain("+5.08");
    expect(text).toContain("Frozen exploratory Metric");
    expect(html).toMatch(/datetime="2026-09-16T12:00:00Z"/i);
    expect(text).not.toContain("Data freshness unavailable");
  });
  it("keeps estimates visible when confidence interval calculation fails", () => {
    const arm = statsWithAnalysisControl().arm_results[0];
    if (!arm) throw new Error("Missing fixture");
    const text = visibleText(
      renderToStaticMarkup(
        <ExperimentResultsComparisonValue
          arm={{ ...arm, status: "error", point_estimate: 0.12 }}
          kind="binomial"
        />,
      ),
    );
    expect(text).toContain("12%");
    expect(text).toContain("Confidence interval unavailable");
  });

  it("does not turn unresolved estimates into zero when Metric metadata is missing", () => {
    const arm = statsWithAnalysisControl().arm_results[0];
    if (!arm) throw new Error("Missing fixture");
    const text = visibleText(
      renderToStaticMarkup(
        <ExperimentResultsComparisonValue
          arm={{ ...arm, status: "insufficient_denominator", point_estimate: 0 }}
          kind={undefined}
        />,
      ),
    );
    expect(text).toBe("Estimate unresolved: insufficient denominator");
  });
  it("does not format estimates or differences without the Metric type", () => {
    const arm = statsWithAnalysisControl().arm_results[0];
    if (!arm) throw new Error("Missing fixture");
    for (const difference of [false, true]) {
      const text = visibleText(
        renderToStaticMarkup(
          <ExperimentResultsComparisonValue
            arm={{ ...arm, point_estimate: 0.0577 }}
            control={arm}
            kind={undefined}
            difference={difference}
          />,
        ),
      );
      expect(text).toBe("Estimate unavailable: Metric type missing");
    }
  });
});
