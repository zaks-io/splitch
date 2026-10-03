import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker";
import { SRM_MISMATCH_P_VALUE } from "./srm-checker-threshold";
import { monteCarloTolerance } from "./sequential-ci-simulation";

const RUN_ID = "run_srm_simulation";
const BASE_TS = "2026-07-01T00:00:00.000Z";
const DELAYED_ACTIVATION_SEED = 2_026_100_3;
const ENTITY_COUNT = 4_000;
const ACTIVATION_PROBABILITY = 0.7;
/** Look fractions of the activated population under continuous monitoring. */
const WATERMARK_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;
const MAX_ACTIVATION_DELAY_MS = 14 * 24 * 60 * 60 * 1_000;

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
      const { exposures, activationRows } = nullActivationPopulation(random, iteration);
      if (anyWatermarkTripsActivatedSrm(exposures, activationRows)) {
        tripped += 1;
      }
    }

    const rejectionRate = tripped / iterations;
    console.info(
      `activated sequential SRM delayed-activation null seed=${seed} iterations=${iterations} ` +
        `entities=${ENTITY_COUNT} watermarks=${WATERMARK_FRACTIONS.join(",")} ` +
        `rejectionRate=${rejectionRate} alpha=${SRM_MISMATCH_P_VALUE} tolerance=${tolerance}`,
    );
    expect(rejectionRate).toBeLessThanOrEqual(SRM_MISMATCH_P_VALUE + tolerance);
  });
});

/**
 * Balanced null: iid Assignment, variant-independent Entity pseudonyms, random
 * Activation inclusion and delays. Exposure days are staggered so activation
 * order is not Exposure order.
 */
function nullActivationPopulation(
  random: () => number,
  iteration: number,
): {
  readonly exposures: DedupeExposureRow[];
  readonly activationRows: ActivationRow[];
} {
  const exposures: DedupeExposureRow[] = [];
  const activationRows: ActivationRow[] = [];

  for (let index = 0; index < ENTITY_COUNT; index += 1) {
    // Pseudonym must not encode the arm; otherwise tie-breaking recreates a
    // fixed control-then-treatment sequence every iteration.
    const entity = `it${iteration}_e${index}_${Math.floor(random() * 1e9)}`;
    const variant = random() < 0.5 ? "control" : "treatment";
    const exposureOffsetMs = Math.floor(random() * MAX_ACTIVATION_DELAY_MS);
    const exposureDay = new Date(Date.parse(BASE_TS) + exposureOffsetMs).toISOString();

    exposures.push({
      app_id: "app_1",
      targeting_key_hash: entity,
      environment_id: "env_1",
      id_type: "user",
      run_id: RUN_ID,
      variant,
      first_exposure_ts: exposureDay,
      first_ingest_ts: exposureDay,
      window_anchor: exposureDay,
    });

    if (random() >= ACTIVATION_PROBABILITY) {
      continue;
    }

    // Delay after Exposure so activation_ts > first_exposure_ts (valid gate).
    const activationDelayMs = 1 + Math.floor(random() * MAX_ACTIVATION_DELAY_MS);
    const activationDay = new Date(Date.parse(exposureDay) + activationDelayMs).toISOString();
    activationRows.push({
      targeting_key_hash: entity,
      run_id: RUN_ID,
      activation_ts: activationDay,
      activation_ingest_ts: activationDay,
      counterfactual: false,
      activated: true,
    });
  }

  return { exposures, activationRows };
}

/**
 * Continuous-monitoring Type I check: peek at several prefixes of the activated
 * population ordered by activation_ingest_ts. Trip if any watermark fires.
 */
function anyWatermarkTripsActivatedSrm(
  exposures: readonly DedupeExposureRow[],
  activationRows: readonly ActivationRow[],
): boolean {
  if (activationRows.length === 0) {
    return false;
  }

  const orderedActivations = [...activationRows].sort((left, right) => {
    const leftMs = Date.parse(requiredIngestTs(left.activation_ingest_ts, "activation_ingest_ts"));
    const rightMs = Date.parse(
      requiredIngestTs(right.activation_ingest_ts, "activation_ingest_ts"),
    );
    if (leftMs !== rightMs) {
      return leftMs - rightMs;
    }
    return left.targeting_key_hash < right.targeting_key_hash
      ? -1
      : left.targeting_key_hash > right.targeting_key_hash
        ? 1
        : 0;
  });

  for (const fraction of WATERMARK_FRACTIONS) {
    const keepCount = Math.max(1, Math.floor(orderedActivations.length * fraction));
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures,
      activation_rows: orderedActivations.slice(0, keepCount),
      srm_procedure: "sequential_martingale",
    });
    if (result.srm.activated_srm_mismatch === true) {
      return true;
    }
  }

  return false;
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
      first_ingest_ts: BASE_TS,
      window_anchor: BASE_TS,
    };
  });
}

function requiredIngestTs(value: string | undefined, field: string): string {
  if (value === undefined || value === "") {
    throw new Error(`${field} is required for activated-SRM simulation fixtures.`);
  }
  return value;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
