import { describe, expect, it } from "vitest";
import {
  meetsAlwaysValidBound,
  monteCarloTolerance,
  runRepeatedLookSimulation,
} from "./sequential-ci-simulation";
import { SequentialCI } from "./sequential-ci";

const PROPERTY_ALPHA = 0.05;
const PROPERTY_ITERATIONS = 300;
const PROPERTY_LOOKS = [20, 35, 55, 80, 120, 180, 260, 380, 520, 700] as const;
const PROPERTY_SEED = "spl-43-property-null";

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
