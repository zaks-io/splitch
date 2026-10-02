import { describe, expect, it } from "vitest";
import { monteCarloTolerance } from "./sequential-ci-simulation";
import { computeSequentialSrm } from "./sequential-srm";

const SIMULATION_ALPHA = 0.05;
const NULL_LOOKS = 2_000;
const DRIFT_TREATMENT_P = 0.52;
const DRIFT_MAX_N = 40_000;
const DRIFT_SEED = 2_026_100_2;

describe("sequential SRM Monte Carlo", () => {
  const iterations = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "300", 10);
  const seed = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_SEED ?? "424242", 10);
  const tolerance = monteCarloTolerance(SIMULATION_ALPHA, iterations);

  it("keeps the continuous-monitoring false-alarm rate within the Monte Carlo bound of alpha", () => {
    const random = seededRandom(seed);
    let tripped = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const batches = Array.from(
        { length: NULL_LOOKS },
        (): Record<string, number> => (random() < 0.5 ? { treatment: 1 } : { control: 1 }),
      );
      const result = computeSequentialSrm({
        allocation: { control: 50, treatment: 50 },
        observations: { mode: "increments", batches },
        alpha: SIMULATION_ALPHA,
      });
      if (result.threshold_crossed) {
        tripped += 1;
      }
    }

    const rejectionRate = tripped / iterations;
    console.info(
      `sequential SRM null seed=${seed} iterations=${iterations} looks=${NULL_LOOKS} ` +
        `rejectionRate=${rejectionRate} tolerance=${tolerance}`,
    );
    expect(rejectionRate).toBeLessThanOrEqual(SIMULATION_ALPHA + tolerance);
  });

  it("detects a seeded 2% allocation drift and records the delay", () => {
    const random = seededRandom(DRIFT_SEED);
    const batches: Array<Record<string, number>> = [];
    for (let index = 0; index < DRIFT_MAX_N; index += 1) {
      batches.push(random() < DRIFT_TREATMENT_P ? { treatment: 1 } : { control: 1 });
    }

    const result = computeSequentialSrm({
      allocation: { control: 50, treatment: 50 },
      observations: { mode: "increments", batches },
      alpha: SIMULATION_ALPHA,
    });

    console.info(
      `sequential SRM 2% drift seed=${DRIFT_SEED} first_cross_n=${result.first_cross_n} ` +
        `wealth=${result.wealth} anytime_p_value=${result.anytime_p_value}`,
    );
    expect(result.threshold_crossed).toBe(true);
    expect(result.first_cross_n).not.toBeNull();
    expect(result.first_cross_n).toBeGreaterThan(0);
    expect(result.first_cross_n).toBeLessThanOrEqual(DRIFT_MAX_N);
  });
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
