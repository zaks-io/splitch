import { describe, expect, it } from "vitest";
import { analyzeStats } from "./stats-engine";
import { binomialStatsInput } from "./stats-engine-test-helpers";

describe("StatsEngine.analyze analysis-v2 Guardrail + ROPE", () => {
  it("applies one-sided Guardrail bound and absolute ROPE under analysis-v2", async () => {
    // A Run started under analysis-v2 must get Prop B.1 Guardrail semantics (#656)
    // and pre-registration ROPE verdicts (#659) on the same analyze pass.
    const input = binomialStatsInput({
      controlN: 400,
      treatmentN: 400,
      controlConversions: 200,
      treatmentConversions: 80,
      includeGuardrail: true,
      horizon: "sequential",
      analysisVersion: "analysis-v2",
    });
    const output = await analyzeStats({
      ...input,
      pre_registration: {
        hypothesis: "Treatment raises conversion without Guardrail harm",
        primary_metric_id: "conversion",
        metrics: [
          {
            metric_id: "conversion",
            desirability: "higher_is_better",
            rope: { lower: -0.05, upper: 0.05, scale: "absolute" },
          },
        ],
        ship_rule: {
          required_margin: 0.02,
          margin_scale: "absolute",
          conflict_resolution: "primary_wins",
        },
      },
    });

    expect(output.guardrail_results[0]?.is_breached).toBe(true);
    expect(output.guardrail_results[0]?.breach_reason).toMatch(
      /one-sided oriented contrast upper bound/,
    );
    const treatment = output.arm_results.find(
      (arm) => arm.metric_id === "conversion" && arm.variant === "treatment",
    );
    expect(treatment?.ropeVerdict).toBeDefined();
    expect(treatment?.ropeScale).toBe("absolute");
    expect(treatment?.ropeVerdictUnavailable).toBeUndefined();
  });
});
