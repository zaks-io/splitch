import type { DedupeExposureRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker";

const RUN_ID = "run_srm_simulation";
const BASE_TS = "2026-07-01T00:00:00.000Z";

describe("SRMChecker simulation smoke", () => {
  it("trips SRM with high probability under biased allocation", () => {
    const iterations = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "25", 10);
    const seed = Number.parseInt(process.env.SPLITCH_STATS_SIMULATION_SEED ?? "424242", 10);
    const random = seededRandom(seed);
    let tripped = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const exposures = biasedExposures(random, 2_000, 0.6);
      const result = checkSrmHealth({
        run_id: RUN_ID,
        allocation: { control: 50, treatment: 50 },
        exposures,
      });
      if (result.srm.srm_is_mismatch) {
        tripped += 1;
      }
    }

    expect(tripped / iterations).toBeGreaterThanOrEqual(0.95);
  });
});

function biasedExposures(
  random: () => number,
  count: number,
  treatmentProbability: number,
): DedupeExposureRow[] {
  return Array.from({ length: count }, (_, index) => {
    const variant = random() < treatmentProbability ? "treatment" : "control";
    return {
      app_id: "app_1",
      targeting_key_hash: `entity_${index}`,
      environment_id: "env_1",
      id_type: "user",
      run_id: RUN_ID,
      variant,
      first_exposure_ts: BASE_TS,
      window_anchor: BASE_TS,
    };
  });
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
