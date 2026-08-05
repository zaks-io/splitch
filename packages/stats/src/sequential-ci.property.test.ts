import { describe, expect, it } from "vitest";
import {
  meetsAlwaysValidBound,
  monteCarloTolerance,
  runFixedHorizonSimulation,
  runRepeatedLookSimulation,
} from "./sequential-ci-simulation";
import { FixedHorizonCI } from "./fixed-horizon-ci";
import { SequentialCI } from "./sequential-ci";

const PROPERTY_ALPHA = 0.05;
const PROPERTY_ITERATIONS = 300;
const PROPERTY_LOOKS = [20, 35, 55, 80, 120, 180, 260, 380, 520, 700] as const;
const PROPERTY_SEED = "spl-43-property-null";

/**
 * The two-sided check needs a tighter Monte Carlo bound than the one-sided
 * always-valid one, because it has to fail on an understated variance as well as
 * an inflated rate. `monteCarloTolerance` floors at 0.02, so iterations past
 * ~1000 buy no extra tightness; 1000 is where the bound stops improving.
 */
const FIXED_HORIZON_ITERATIONS = 1_000;
const FIXED_HORIZON_LOCKED_N = 400;

describe("SequentialCI repeated-look property", () => {
  it("keeps the null repeated-look rejection rate within the Monte Carlo bound", () => {
    const result = runRepeatedLookSimulation({
      adapter: new SequentialCI(),
      method: "sequential",
      alpha: PROPERTY_ALPHA,
      seed: PROPERTY_SEED,
      iterations: PROPERTY_ITERATIONS,
      lookSchedule: PROPERTY_LOOKS,
      target_n: 700,
    });
    const tolerance = monteCarloTolerance(PROPERTY_ALPHA, PROPERTY_ITERATIONS);

    expect(meetsAlwaysValidBound(result, tolerance)).toBe(true);
  });

  it("detects inflated false positives for repeated fixed-horizon peeking", () => {
    const result = runRepeatedLookSimulation({
      adapter: new SequentialCI(),
      method: "fixed-horizon",
      alpha: PROPERTY_ALPHA,
      seed: PROPERTY_SEED,
      iterations: PROPERTY_ITERATIONS,
      lookSchedule: PROPERTY_LOOKS,
      target_n: 700,
    });
    const tolerance = monteCarloTolerance(PROPERTY_ALPHA, PROPERTY_ITERATIONS);

    expect(meetsAlwaysValidBound(result, tolerance)).toBe(false);
    expect(result.rejectionRate).toBeGreaterThan(PROPERTY_ALPHA + tolerance);
  });
});

describe("FixedHorizonCI single-look property", () => {
  // The sequential bound above is one-sided: it only fails when the rate climbs
  // past alpha, so an understated sampling variance stays invisible to it until
  // the extra rejections cross alpha. This one is two-sided, which is what makes
  // the estimator's variance path a PR-gated contract rather than a nightly one.
  it("holds the null rejection rate at alpha for a locked sample size", () => {
    const result = runFixedHorizonSimulation({
      adapter: new FixedHorizonCI(),
      alpha: PROPERTY_ALPHA,
      seed: PROPERTY_SEED,
      iterations: FIXED_HORIZON_ITERATIONS,
      sample_size_locked: FIXED_HORIZON_LOCKED_N,
    });
    const tolerance = monteCarloTolerance(PROPERTY_ALPHA, FIXED_HORIZON_ITERATIONS);

    expect(Math.abs(result.rejectionRate - PROPERTY_ALPHA)).toBeLessThanOrEqual(tolerance);
  });
});
