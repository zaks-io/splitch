import { describe, expect, it } from "vitest";
import { analyzeStats } from "./stats-engine.js";
import { binomialStatsInput } from "./stats-engine-test-helpers.js";

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
});
