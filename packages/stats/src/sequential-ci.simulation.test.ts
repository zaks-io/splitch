import { describe, expect, it } from "vitest";
import {
  meetsAlwaysValidBound,
  runFixedHorizonSimulation,
  monteCarloTolerance,
  runRepeatedLookSimulation,
} from "./sequential-ci-simulation";
import { FixedHorizonCI } from "./fixed-horizon-ci";
import { SequentialCI } from "./sequential-ci";

const SIMULATION_ALPHA = 0.05;
const AUDIT_LOOKS = [20, 35, 55, 80, 120, 180, 260, 380, 520, 700, 950, 1_250] as const;
const SMOKE_LOOKS = [20, 50, 100, 200, 400] as const;

describe("SequentialCI audit simulation", () => {
  const mode = process.env.SPLITCH_STATS_SIMULATION_MODE === "audit" ? "audit" : "smoke";
  const seed = process.env.SPLITCH_STATS_SIMULATION_SEED ?? "424242";
  const iterations = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "25", 10);
  const lookSchedule = mode === "audit" ? AUDIT_LOOKS : SMOKE_LOOKS;
  const tolerance = monteCarloTolerance(SIMULATION_ALPHA, iterations);

  it("certifies the always-valid Type-I bound under repeated null looks", () => {
    const result = runRepeatedLookSimulation({
      adapter: new SequentialCI(),
      method: "sequential",
      alpha: SIMULATION_ALPHA,
      seed,
      iterations,
      lookSchedule,
      target_n: 1_250,
    });

    console.info(
      `SequentialCI ${mode} seed=${seed} iterations=${iterations} rejectionRate=${result.rejectionRate} tolerance=${tolerance}`,
    );
    expect(meetsAlwaysValidBound(result, tolerance)).toBe(true);
  });

  it("certifies that the repeated fixed-horizon peeking control fails the bound", () => {
    const result = runRepeatedLookSimulation({
      adapter: new SequentialCI(),
      method: "fixed-horizon",
      alpha: SIMULATION_ALPHA,
      seed,
      iterations,
      lookSchedule,
      target_n: 1_250,
    });

    console.info(
      `Fixed-horizon peeking ${mode} seed=${seed} iterations=${iterations} rejectionRate=${result.rejectionRate} tolerance=${tolerance}`,
    );
    expect(meetsAlwaysValidBound(result, tolerance)).toBe(false);
    expect(result.rejectionRate).toBeGreaterThan(SIMULATION_ALPHA + tolerance);
  });

  it("certifies fixed-horizon Type-I control at the locked sample size", () => {
    const result = runFixedHorizonSimulation({
      adapter: new FixedHorizonCI(),
      alpha: SIMULATION_ALPHA,
      seed,
      iterations,
      sample_size_locked: 400,
    });

    console.info(
      `FixedHorizonCI ${mode} seed=${seed} iterations=${iterations} rejectionRate=${result.rejectionRate} tolerance=${tolerance}`,
    );
    expect(Math.abs(result.rejectionRate - SIMULATION_ALPHA)).toBeLessThanOrEqual(tolerance);
  });
});
