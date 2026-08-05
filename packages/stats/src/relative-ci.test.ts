import { describe, expect, it } from "vitest";
import { ALPHA, binomialStatsInput } from "./relative-ci-test-helpers";
import { analyzeStats } from "./stats-engine";

/**
 * ADR-0014: the interval a reader sees must be the interval the decision was
 * made on. The published relative interval is derived from the absolute-lift
 * interval, so it must exclude zero exactly when the decision rejects. Two
 * independently estimated intervals do not: because the relative test statistic
 * is smaller than the absolute one for a win and larger for a loss, they
 * disagree in a band around the threshold, and the disagreement is one-sided by
 * direction. 20% -> 15% at n=350 read "not significant" beside an interval
 * entirely below zero.
 */

const CASES = [
  { label: "win just past the threshold", control: [1000, 100], treatment: [1000, 130] },
  { label: "win well past the threshold", control: [1000, 100], treatment: [1000, 140] },
  { label: "win at a small sample", control: [100, 20], treatment: [100, 40] },
  { label: "no difference", control: [500, 100], treatment: [500, 100] },
  { label: "loss just short of the threshold", control: [350, 70], treatment: [350, 52] },
  { label: "loss short of the threshold", control: [400, 80], treatment: [400, 60] },
  { label: "loss past the threshold", control: [300, 90], treatment: [300, 66] },
] as const;

describe("published relative interval agrees with the decision", () => {
  for (const horizon of ["fixed", "sequential"] as const) {
    for (const testCase of CASES) {
      it(`${testCase.label} on the ${horizon} horizon`, async () => {
        const output = await analyzeStats(
          binomialStatsInput(testCase.control, testCase.treatment, horizon),
        );
        const treatment = output.arm_results.find((arm) => arm.variant === "treatment");
        if (!treatment || treatment.ci_lower === null || treatment.ci_upper === null) {
          throw new Error("expected a Treatment arm with a published interval.");
        }

        const excludesZero = treatment.ci_lower > 0 || treatment.ci_upper < 0;
        expect(excludesZero).toBe(treatment.p_value < ALPHA);
        expect(treatment.relative_lift_pct).not.toBeNull();
        expect(treatment.relative_lift_pct ?? Number.NaN).toBeGreaterThanOrEqual(
          treatment.ci_lower,
        );
        expect(treatment.relative_lift_pct ?? Number.NaN).toBeLessThanOrEqual(treatment.ci_upper);
      });
    }
  }
});
