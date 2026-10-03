import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker";
import { SRM_MISMATCH_P_VALUE } from "./srm-checker-threshold";
import { monteCarloTolerance } from "./sequential-ci-simulation";

const RUN_ID = "run_srm_simulation";
const BASE_TS = "2026-07-01T00:00:00.000Z";
const DELAYED_ACTIVATION_SEED = 2_026_100_3;
const COHORTS = 100;
const ENTITIES_PER_COHORT_ARM = 20;

describe("SRMChecker simulation smoke", () => {
  it("trips SRM with high probability under biased allocation", () => {
    const iterations = Number.parseInt(
      process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "300",
      10,
    );
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

  it("keeps delayed reverse-order activation false alarms within alpha plus Monte Carlo tolerance", {
    timeout: 120_000,
  }, () => {
    const iterations = Number.parseInt(
      process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "300",
      10,
    );
    const seed = Number.parseInt(
      process.env.SPLITCH_STATS_SIMULATION_SEED ?? String(DELAYED_ACTIVATION_SEED),
      10,
    );
    const random = seededRandom(seed);
    const tolerance = monteCarloTolerance(SRM_MISMATCH_P_VALUE, iterations);
    let tripped = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const { exposures, activationRows } = delayedReverseActivationCohort(random, iteration);
      const result = checkSrmHealth({
        run_id: RUN_ID,
        allocation: { control: 50, treatment: 50 },
        exposures,
        activation_rows: activationRows,
        srm_procedure: "sequential_martingale",
      });
      if (result.srm.activated_srm_mismatch === true) {
        tripped += 1;
      }
    }

    const rejectionRate = tripped / iterations;
    console.info(
      `activated sequential SRM delayed-activation null seed=${seed} iterations=${iterations} ` +
        `cohorts=${COHORTS} rejectionRate=${rejectionRate} alpha=${SRM_MISMATCH_P_VALUE} ` +
        `tolerance=${tolerance}`,
    );
    expect(rejectionRate).toBeLessThanOrEqual(SRM_MISMATCH_P_VALUE + tolerance);
  });
});

/**
 * Balanced null Assignment across many Exposure-day cohorts. Activations are
 * arm-independent and arrive in reverse Exposure-day order so the activated
 * filtration must follow activation_ts, not first Exposure.
 */
function delayedReverseActivationCohort(
  random: () => number,
  iteration: number,
): {
  readonly exposures: DedupeExposureRow[];
  readonly activationRows: ActivationRow[];
} {
  const exposures: DedupeExposureRow[] = [];
  const activationRows: ActivationRow[] = [];

  for (let cohort = 0; cohort < COHORTS; cohort += 1) {
    const exposureDay = new Date(Date.UTC(2026, 6, 1 + cohort)).toISOString();
    // All activations land after the last Exposure day, in reverse cohort order.
    const activationDay = new Date(
      Date.UTC(2026, 6, 1 + COHORTS + (COHORTS - 1 - cohort)),
    ).toISOString();

    for (const variant of ["control", "treatment"] as const) {
      for (let index = 0; index < ENTITIES_PER_COHORT_ARM; index += 1) {
        // Keep Assignment balanced under the null; random only diversifies hashes.
        const entity = `it${iteration}_c${cohort}_${variant}_${index}_${Math.floor(random() * 1e9)}`;
        exposures.push({
          app_id: "app_1",
          targeting_key_hash: entity,
          environment_id: "env_1",
          id_type: "user",
          run_id: RUN_ID,
          variant,
          first_exposure_ts: exposureDay,
          window_anchor: exposureDay,
        });
        activationRows.push({
          targeting_key_hash: entity,
          run_id: RUN_ID,
          activation_ts: activationDay,
          counterfactual: false,
          activated: true,
        });
      }
    }
  }

  return { exposures, activationRows };
}

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
