import { describe, expect, it } from "vitest";
import { analyzeStats } from "./stats-engine";
import { binomialStatsInput } from "./stats-engine-test-helpers";

describe("StatsEngine metamorphic properties", () => {
  it("returns the same output for the same input", async () => {
    const input = binomialStatsInput({
      controlN: 120,
      treatmentN: 120,
      controlConversions: 30,
      treatmentConversions: 42,
      includeGuardrail: true,
    });

    await expect(analyzeStats(input)).resolves.toEqual(await analyzeStats(input));
  });

  it("does not depend on Exposure or Metric row order", async () => {
    const input = binomialStatsInput({
      controlN: 120,
      treatmentN: 120,
      controlConversions: 30,
      treatmentConversions: 42,
      includeGuardrail: true,
    });
    const reordered = {
      ...input,
      exposures: [...input.exposures].reverse(),
      metric_values: [...input.metric_values].reverse(),
    };

    await expect(analyzeStats(reordered)).resolves.toEqual(await analyzeStats(input));
  });

  it("keeps total-loss Binomial evidence finite across small and large arm sizes", async () => {
    for (const sampleSize of [2, 3, 10, 100]) {
      const output = await analyzeStats(
        binomialStatsInput({
          controlN: sampleSize,
          treatmentN: sampleSize,
          controlConversions: sampleSize,
          treatmentConversions: 0,
          horizon: "fixed",
          sampleSizeLocked: sampleSize,
          includeGuardrail: true,
        }),
      );
      const treatment = output.arm_results.find(
        (result) => result.metric_id === "conversion" && result.variant === "treatment",
      );

      expect(treatment).toBeDefined();
      expect(treatment?.p_value).toBeGreaterThan(0);
      expect(treatment?.p_value).toBeLessThan(1);
      expect(treatment?.ci_lower).toBeLessThan(-100);
    }
  });
});
