import { describe, expect, it } from "vitest";
import {
  breachedGuardrailStats,
  metricsFixture,
  resultsFixture,
  statsWithAnalysisControl,
} from "../../components/experiments/experiment-results-test-fixtures";
import { metricNamesById } from "./metric-names";
import { experimentResultsVerdict } from "./experiment-results-verdict";

describe("experimentResultsVerdict", () => {
  it("selects the largest significant comparison for the leading Variant", () => {
    const results = resultsFixture(statsWithAnalysisControl());

    expect(verdictText(results)).toContain(
      "treatment moves Checkout conversion +6.4%, significant.",
    );
  });

  it("stays calm when there is no affirmative significance call", () => {
    const results = resultsFixture(statsWithAnalysisControl());
    const significance = Object.fromEntries(
      Object.keys(results.significance).map((key) => [key, "not_significant"] as const),
    );

    expect(verdictText({ ...results, significance })).toContain(
      "No affirmative significance call yet.",
    );
  });

  it("counts multiple Guardrail breaches", () => {
    const stats = breachedGuardrailStats();
    const [guardrail] = stats.guardrail_results;
    if (!guardrail) throw new Error("breached fixture must produce a Guardrail");
    const results = resultsFixture({
      ...stats,
      guardrail_results: [guardrail, { ...guardrail, metric_id: "checkout_error_rate" }],
    });

    expect(verdictText(results)).toContain("2 Guardrails are breached.");
  });

  it("counts multiple blocking checks without re-deriving them", () => {
    const base = resultsFixture(statsWithAnalysisControl());
    const checks = base.gate.checks.map((check) =>
      check.id === "underpowered" || check.id === "decision_valid_result"
        ? { ...check, status: "fail" as const }
        : check,
    );
    const blockedBy: typeof base.gate.blockedBy = ["underpowered", "decision_valid_result"];
    const results = {
      ...base,
      gate: {
        ...base.gate,
        shipAllowed: false,
        blockedBy,
        checks,
      },
    };
    const failing = results.gate.checks.filter((check) => check.status === "fail").length;

    expect(failing).toBeGreaterThan(1);
    expect(verdictText(results)).toContain(`The gate is blocked by ${failing} checks.`);
  });

  it("never counts an inconsistent display as significant", () => {
    const results = resultsFixture(statsWithAnalysisControl());
    const treatmentKey = Object.keys(results.significance).find((key) =>
      key.endsWith("/treatment"),
    );
    if (!treatmentKey) throw new Error("fixture must produce Treatment significance");

    expect(
      verdictText({
        ...results,
        significance: { ...results.significance, [treatmentKey]: "inconsistent" },
      }),
    ).toContain("No affirmative significance call yet.");
  });
});

function verdictText(results: ReturnType<typeof resultsFixture>): string {
  return experimentResultsVerdict({
    armResults: results.stats.arm_results,
    significance: results.significance,
    guardrails: results.stats.guardrail_results,
    gate: results.gate,
    baseline: "control",
    metricNames: metricNamesById(metricsFixture()),
  })
    .map((segment) => segment.value)
    .join("");
}
