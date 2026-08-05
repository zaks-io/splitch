import { describe, expect, it } from "vitest";
import { ALPHA, countStatsInput, randomBetween, seededRandom } from "./relative-ci-test-helpers";
import { analyzeStats } from "./stats-engine";

/**
 * ADR-0015 rule 4: the published relative interval is the absolute decision
 * interval inverted, so it must exclude 0% lift exactly when the decision
 * rejects. That is an invariant over every Metric shape, not seven Binomial
 * examples, and Count and Revenue Metrics reach parts of Fieller's quadratic a
 * conversion rate never does: a Control mean that is negative, and a Control
 * mean not separated from zero.
 *
 * The biconditional is conditional on a bounded interval, which is not a
 * loophole but the actual mathematics. When the Control mean is not separated
 * from zero the ratio has no bounded interval no matter how significant the
 * absolute difference is, and the engine says so with an infinite bound. The
 * last two tests pin that case rather than generate around it.
 */

const ITERATIONS = 60;

/** Far enough from zero that Fieller's leading coefficient is always positive. */
const SEPARATED_SPREAD = { min: 1, max: 4 } as const;

describe("Fieller relative interval invariants on additive Metrics", () => {
  it("excludes zero exactly when the decision rejects", { timeout: 120_000 }, async () => {
    const random = seededRandom(51_147);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const controlMean = randomBetween(random, 8, 20);
      const treatment = await treatmentArm(random, controlMean, randomBetween(random, -1.2, 1.2));

      expect(Number.isFinite(treatment.ci_lower)).toBe(true);
      const excludesZero = treatment.ci_lower > 0 || treatment.ci_upper < 0;
      expect(excludesZero).toBe(treatment.p_value < ALPHA);
    }
  });

  it("keeps the invariant when the Control mean is negative", { timeout: 120_000 }, async () => {
    const random = seededRandom(118_205);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const controlMean = randomBetween(random, -20, -8);
      const treatment = await treatmentArm(random, controlMean, randomBetween(random, -1.2, 1.2));

      expect(Number.isFinite(treatment.ci_lower)).toBe(true);
      const excludesZero = treatment.ci_lower > 0 || treatment.ci_upper < 0;
      expect(excludesZero).toBe(treatment.p_value < ALPHA);
    }
  });

  it("contains its own point estimate", { timeout: 120_000 }, async () => {
    const random = seededRandom(660_401);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const controlMean = randomBetween(random, 8, 30);
      const treatment = await treatmentArm(random, controlMean, randomBetween(random, -2, 2));

      expect(treatment.relative_lift_pct).not.toBeNull();
      expect(treatment.relative_lift_pct ?? Number.NaN).toBeGreaterThanOrEqual(treatment.ci_lower);
      expect(treatment.relative_lift_pct ?? Number.NaN).toBeLessThanOrEqual(treatment.ci_upper);
    }
  });

  it("publishes an unbounded interval when the Control mean straddles zero", async () => {
    const treatment = await unestimableControlArm();

    expect(treatment.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(treatment.ci_upper).toBe(Number.POSITIVE_INFINITY);
  });

  it("leaves a Guardrail undetermined rather than breached on an unbounded bound", async () => {
    const output = await analyzeStats(
      countStatsInput(seededRandom(303_882), {
        controlMean: 0.05,
        treatmentMean: 8.05,
        spread: 8,
        n: 120,
        guardrailThreshold: -5,
      }),
    );
    const [guardrail] = output.guardrail_results;

    // An unbounded lower bound is not below the threshold, it is unknown. A
    // Guardrail must say so rather than pass silently or fire on -Infinity.
    expect(guardrail?.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(guardrail?.is_breached).toBeNull();
  });
});

/** A Control arm whose mean sits well inside its own standard error of zero. */
async function unestimableControlArm() {
  return treatmentArm(seededRandom(303_882), 0.05, 8, { spread: 8, n: 120 });
}

async function treatmentArm(
  random: () => number,
  controlMean: number,
  meanShift: number,
  override?: { spread: number; n: number },
) {
  const spread =
    override?.spread ?? randomBetween(random, SEPARATED_SPREAD.min, SEPARATED_SPREAD.max);
  const output = await analyzeStats(
    countStatsInput(random, {
      controlMean,
      treatmentMean: controlMean + meanShift,
      spread,
      n: override?.n ?? 200,
    }),
  );

  const treatment = output.arm_results.find((arm) => arm.variant === "treatment");
  if (!treatment || treatment.ci_lower === null || treatment.ci_upper === null) {
    throw new Error("expected a Treatment arm with a published interval.");
  }
  return { ...treatment, ci_lower: treatment.ci_lower, ci_upper: treatment.ci_upper };
}
