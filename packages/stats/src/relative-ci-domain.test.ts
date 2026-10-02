import { describe, expect, it } from "vitest";
import { countStatsInput, seededRandom } from "./relative-ci-test-helpers";
import { analyzeStats } from "./stats-engine";
import { binomialStatsInput } from "./stats-engine-test-helpers";

/**
 * Domain of the published relative interval. These are not silent substitutions:
 * zero Control already withholds the percentage, and a Control mean that is not
 * separated from zero publishes an unbounded interval so the Guardrail stays
 * undetermined. Signed Control means remain defined.
 */
describe("relative-lift domain on signed, zero, and near-zero Control means", () => {
  it("withholds relative lift when the Control mean is exactly zero", async () => {
    const output = await analyzeStats(
      binomialStatsInput({
        controlN: 120,
        treatmentN: 120,
        controlConversions: 0,
        treatmentConversions: 80,
        horizon: "fixed",
        sampleSizeLocked: 120,
        includeGuardrail: true,
      }),
    );
    const treatment = output.arm_results.find(
      (arm) => arm.variant === "treatment" && arm.metric_id === "conversion",
    );
    if (!treatment) {
      throw new Error("expected a Treatment conversion arm");
    }

    expect(treatment.relative_lift_pct).toBeNull();
    expect(treatment.ci_lower).toBeNull();
    expect(treatment.ci_upper).toBeNull();
    expect(output.guardrail_results[0]?.is_breached).toBeNull();
  });

  it("publishes a bounded interval when the Control mean is negative and separated", async () => {
    const output = await analyzeStats(
      countStatsInput(seededRandom(22), {
        controlMean: -12,
        treatmentMean: -9,
        spread: 1.5,
        n: 220,
      }),
    );
    const treatment = treatmentArm(output);

    expect(treatment.relative_lift_pct).not.toBeNull();
    expect(Number.isFinite(treatment.ci_lower)).toBe(true);
    expect(Number.isFinite(treatment.ci_upper)).toBe(true);
    expect(treatment.ci_lower).toBeLessThan(treatment.relative_lift_pct ?? Number.NaN);
    expect(treatment.ci_upper).toBeGreaterThan(treatment.relative_lift_pct ?? Number.NaN);
  });

  it("stays unbounded, not finite-looking, when the Control mean sits on zero", async () => {
    const output = await analyzeStats(
      countStatsInput(seededRandom(33), {
        controlMean: 0.04,
        treatmentMean: 6,
        spread: 7,
        n: 140,
        guardrailThreshold: -5,
      }),
    );
    const treatment = treatmentArm(output);

    expect(treatment.relative_lift_pct).not.toBeNull();
    expect(treatment.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(treatment.ci_upper).toBe(Number.POSITIVE_INFINITY);
    expect(output.guardrail_results[0]?.is_breached).toBeNull();
  });
});

function treatmentArm(output: Awaited<ReturnType<typeof analyzeStats>>) {
  const treatment = output.arm_results.find((arm) => arm.variant === "treatment");
  if (!treatment) {
    throw new Error("expected a Treatment arm");
  }
  return treatment;
}
