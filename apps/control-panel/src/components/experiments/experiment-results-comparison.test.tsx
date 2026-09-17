import type { StatsOutput } from "@splitch/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

function threeArmStats(): StatsOutput {
  const stats = statsWithAnalysisControl();
  const template = stats.arm_results[1];
  if (!template) throw new Error("Missing fixture Treatment arm");
  const control = stats.arm_results[0];
  if (!control) throw new Error("Missing fixture Control arm");
  stats.arm_results = [
    { ...control, point_estimate: 34.92 },
    { ...template, variant: "fast", point_estimate: 23.19, relative_lift_pct: -33.6 },
    { ...template, variant: "slow", point_estimate: 40, relative_lift_pct: 14.5 },
  ];
  return stats;
}

describe("ExperimentResultsComparison", () => {
  it("leads with the relative difference and keeps the recorded estimates under it", () => {
    const html = renderComparison();
    const text = visibleText(html);
    expect(text).toContain("+6.4%");
    expect(text).toContain("1.67%");
    expect(text).toContain("5.77%");
    expect(text).toContain("+4.1 pp");
    expect(text).toContain("1.67% → 5.77%");
    expect(text).toContain("treatment vs control");
    expect(text).toContain("Data freshness unavailable");
    expect(html).not.toContain("accordion");
  });

  it("groups Metrics by the role the Run froze for them", () => {
    const stats = statsWithAnalysisControl();
    const text = visibleText(
      renderToStaticMarkup(
        <ExperimentResultsComparison
          results={resultsFixture(stats)}
          run={runFixture({
            decisionMetricIds: ["checkout_conversion"],
            decisionGuardrailMetricIds: ["checkout_latency_p95"],
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
            { id: "checkout_conversion", name: "Checkout conversion", kind: "binomial" },
            { id: "checkout_latency_p95", name: "Checkout latency", kind: "count" },
            { id: "frozen", name: "Frozen exploratory Metric", kind: "count" },
          ]}
          baseline="control"
          variantOrder={["control", "treatment"]}
        />,
      ),
    );
    const decision = text.indexOf("Decision metrics");
    const guardrails = text.indexOf("Guardrails");
    const exploratory = text.indexOf("Exploratory");
    expect(decision).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(text.indexOf("Checkout conversion"));
    expect(text.indexOf("Checkout conversion")).toBeLessThan(guardrails);
    expect(guardrails).toBeLessThan(text.indexOf("Checkout latency"));
    expect(text.indexOf("Checkout latency")).toBeLessThan(exploratory);
    expect(exploratory).toBeLessThan(text.indexOf("Frozen exploratory Metric"));
    expect(text).toContain("Significant");
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
    expect(text).not.toMatch(/\b0%/);
  });

  it("does not present an unavailable ratio estimate as zero", () => {
    const text = visibleText(renderComparison({ zero: true, ratio: true }));
    expect(text).toContain("Estimate unresolved: insufficient denominator");
    expect(text).not.toContain("+6.4%");
    expect(text).not.toMatch(/\b0\.0+\b/);
  });
});

describe("ExperimentResultsComparison ordering and states", () => {
  it("orders rows by the size of the move and reads several treatments in recorded units", () => {
    const stats = threeArmStats();
    const [control, fast] = stats.arm_results;
    if (!control || !fast) throw new Error("Missing fixture arms");
    stats.arm_results.push({
      ...fast,
      metric_id: "quiet",
      point_estimate: 1.01,
      relative_lift_pct: 1.2,
    });
    stats.arm_results.push({ ...control, metric_id: "quiet", point_estimate: 1 });
    const html = renderToStaticMarkup(
      <ExperimentResultsComparison
        results={resultsFixture(stats, {
          dataWatermark: "2026-09-16T12:00:00Z",
          resultToken: `sha256:${"a".repeat(64)}`,
        })}
        run={runFixture({ decisionMetricIds: ["quiet", "checkout_conversion"] })}
        metrics={[
          { id: "checkout_conversion", name: "Duration", kind: "ratio" },
          { id: "quiet", name: "Quiet Metric", kind: "count" },
        ]}
        baseline="control"
        variantOrder={["control", "fast", "slow"]}
      />,
    );
    const text = visibleText(html);
    expect(text).toContain("-33.6%");
    expect(text).toContain("-11.73");
    expect(text).toContain("+14.5%");
    expect(text).toContain("+5.08");
    expect(text.indexOf("Duration")).toBeLessThan(text.indexOf("Quiet Metric"));
    expect(text.indexOf("fast")).toBeLessThan(text.indexOf("slow"));
    expect(text).not.toContain("fast vs control");
    expect(html).toMatch(/datetime="2026-09-16T12:00:00Z"/i);
    expect(text).not.toContain("Data freshness unavailable");
  });

  it("marks a breached Guardrail in words and draws its threshold", () => {
    const stats = statsWithAnalysisControl();
    const treatment = stats.arm_results[1];
    if (!treatment) throw new Error("Missing fixture Treatment arm");
    stats.arm_results.push({
      ...treatment,
      metric_id: "checkout_latency_p95",
      relative_lift_pct: -18.2,
      ci_lower: -24.6,
      ci_upper: -11.8,
      is_significant: false,
    });
    const [guardrail] = stats.guardrail_results;
    if (!guardrail) throw new Error("Missing fixture Guardrail");
    stats.guardrail_results = [{ ...guardrail, ci_lower: -24.6, is_breached: true }];
    const html = renderToStaticMarkup(
      <ExperimentResultsComparison
        results={resultsFixture(stats)}
        run={runFixture({ decisionGuardrailMetricIds: ["checkout_latency_p95"] })}
        metrics={[
          { id: "checkout_conversion", name: "Checkout conversion", kind: "binomial" },
          { id: "checkout_latency_p95", name: "Checkout latency", kind: "count" },
        ]}
        baseline="control"
        variantOrder={["control", "treatment"]}
      />,
    );
    const text = visibleText(html);
    expect(text).toContain("Breached");
    expect(text).toContain("-18.2%");
    expect(html).toContain('stroke-dasharray="3 3"');
  });

  it("keeps estimates visible when confidence interval calculation fails", () => {
    const stats = statsWithAnalysisControl();
    stats.arm_results = stats.arm_results.map((arm) =>
      arm.variant === "treatment"
        ? { ...arm, status: "error", point_estimate: 0.12, ci_lower: null, ci_upper: null }
        : arm,
    );
    const text = visibleText(
      renderToStaticMarkup(
        <ExperimentResultsComparison
          results={resultsFixture(stats)}
          run={runFixture()}
          metrics={[{ id: "checkout_conversion", name: "Checkout conversion", kind: "binomial" }]}
          baseline="control"
          variantOrder={["control", "treatment"]}
        />,
      ),
    );
    expect(text).toContain("12%");
    expect(text).toContain("Confidence interval unavailable");
  });

  it("does not format estimates or differences when the Metric is missing from the catalog", () => {
    const text = visibleText(
      renderToStaticMarkup(
        <ExperimentResultsComparison
          results={resultsFixture(statsWithAnalysisControl())}
          run={runFixture()}
          metrics={[]}
          baseline="control"
          variantOrder={["control", "treatment"]}
        />,
      ),
    );
    expect(text).toContain("Estimate unavailable: Metric type missing");
    expect(text).not.toContain("18.4%");
    expect(text).not.toContain("+6.4%");
  });
});
