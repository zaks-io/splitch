import { describe, expect, it } from "vitest";
import {
  ALPHA,
  CORRELATIONS,
  TOLERANCE,
  binomialAaTrial,
  countAaTrial,
  mulberry32,
  rejectionRate,
} from "./cuped-type-i-test-helpers";

/**
 * CUPED is a variance reduction, so it has to leave the false-positive rate at
 * nominal. Centering each arm on its own covariate mean does not: the
 * adjustment cancels to zero inside the arm, so the lift keeps the full
 * covariate imbalance while the reported variance falls to the residual. The
 * interval narrows around an uncorrected estimate and the rejection rate climbs
 * with the covariate correlation. At rho = 0.9 that took the realized type-I
 * error to roughly 40% against a nominal 5%.
 *
 * Asserting that CUPED "does not move the point estimate" cannot catch this,
 * because under per-arm centering that holds for every covariate. Only an A/A
 * rejection rate does, and it has to be swept across the sign and size of the
 * correlation: the inflation scales with rho, so a single weakly-correlated
 * covariate would certify a broken implementation. ADR-0016 records this as a
 * standing obligation on the suite.
 */

describe("CUPED type-I error under A/A", () => {
  it("holds the nominal rejection rate without CUPED", { timeout: 120_000 }, () => {
    const raw = rejectionRate((rand) => countAaTrial(rand, { useCuped: false, correlation: 0.9 }));

    expect(raw).toBeGreaterThan(ALPHA - TOLERANCE);
    expect(raw).toBeLessThan(ALPHA + TOLERANCE);
  });

  for (const correlation of CORRELATIONS) {
    it(`holds the nominal rejection rate at a count covariate of rho ${correlation}`, {
      timeout: 120_000,
    }, () => {
      const cuped = rejectionRate((rand) => countAaTrial(rand, { useCuped: true, correlation }));

      expect(cuped).toBeGreaterThan(ALPHA - TOLERANCE);
      expect(cuped).toBeLessThan(ALPHA + TOLERANCE);
    });
  }

  it("holds the nominal rejection rate on a Binomial Metric", { timeout: 120_000 }, () => {
    const cuped = rejectionRate((rand) =>
      binomialAaTrial(rand, { useCuped: true, agreement: 0.7 }),
    );

    expect(cuped).toBeGreaterThan(ALPHA - TOLERANCE);
    expect(cuped).toBeLessThan(ALPHA + TOLERANCE);
  });

  it("moves the point estimate toward the covariate-adjusted lift", () => {
    for (let trial = 0; trial < 3; trial += 1) {
      const seed = 99 + trial;
      const raw = countAaTrial(mulberry32(seed), { useCuped: false, correlation: 0.9 });
      const cuped = countAaTrial(mulberry32(seed), { useCuped: true, correlation: 0.9 });

      // Same seed, same data. Only the adjustment differs, and it must both
      // correct the estimate and shrink the interval.
      expect(cuped.absolute_lift).not.toBe(raw.absolute_lift);
      expect(cuped.absolute_lift_sampling_var ?? Number.NaN).toBeLessThan(
        raw.absolute_lift_sampling_var ?? Number.NaN,
      );
      expect(cuped.variance_techniques.cuped_method).toBe("pre_period");
    }
  });
});
