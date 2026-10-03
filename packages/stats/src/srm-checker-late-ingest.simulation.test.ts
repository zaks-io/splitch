import type { DedupeExposureRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { monteCarloTolerance } from "./sequential-ci-simulation";
import { checkSrmHealth } from "./srm-checker";
import { SRM_MISMATCH_P_VALUE } from "./srm-checker-threshold";

const RUN_ID = "run_srm_late_ingest_sim";
const BASE_TS = "2026-07-01T00:00:00.000Z";
const LATE_INGEST_SEED = 2_026_100_6;
const ENTITY_COUNT = 4_000;
const WATERMARK_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;
const MAX_EVENT_OFFSET_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_INGEST_LAG_MS = 7 * 24 * 60 * 60 * 1_000;

describe("SRMChecker late-ingestion null simulation", () => {
  it("keeps false alarms within alpha plus Monte Carlo tolerance under ingest reordering", {
    timeout: 120_000,
  }, () => {
    const iterations = Number.parseInt(
      process.env.SPLITCH_STATS_SIMULATION_ITERATIONS ?? "300",
      10,
    );
    const seed = Number.parseInt(
      process.env.SPLITCH_STATS_SIMULATION_SEED ?? String(LATE_INGEST_SEED),
      10,
    );
    const random = seededRandom(seed);
    const tolerance = monteCarloTolerance(SRM_MISMATCH_P_VALUE, iterations);
    let tripped = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const exposures = nullLateIngestPopulation(random, iteration);
      if (anyIngestWatermarkTripsExposureSrm(exposures)) {
        tripped += 1;
      }
    }

    const rejectionRate = tripped / iterations;
    console.info(
      `Exposure sequential SRM late-ingest null seed=${seed} iterations=${iterations} ` +
        `entities=${ENTITY_COUNT} watermarks=${WATERMARK_FRACTIONS.join(",")} ` +
        `rejectionRate=${rejectionRate} alpha=${SRM_MISMATCH_P_VALUE} tolerance=${tolerance}`,
    );
    expect(rejectionRate).toBeLessThanOrEqual(SRM_MISMATCH_P_VALUE + tolerance);
  });
});

/**
 * Balanced null with iid Assignment. Event times and ingest times are drawn
 * independently so ingest order is not event order; the path still uses ingest.
 */
function nullLateIngestPopulation(random: () => number, iteration: number): DedupeExposureRow[] {
  const exposures: DedupeExposureRow[] = [];
  for (let index = 0; index < ENTITY_COUNT; index += 1) {
    const entity = `it${iteration}_e${index}_${Math.floor(random() * 1e9)}`;
    const variant = random() < 0.5 ? "control" : "treatment";
    const eventMs = Date.parse(BASE_TS) + Math.floor(random() * MAX_EVENT_OFFSET_MS);
    // Ingest after event, with enough lag that prefixes by ingest scramble event order.
    const ingestMs = eventMs + 1 + Math.floor(random() * MAX_INGEST_LAG_MS);
    const eventTs = new Date(eventMs).toISOString();
    const ingestTs = new Date(ingestMs).toISOString();
    exposures.push({
      app_id: "app_1",
      targeting_key_hash: entity,
      environment_id: "env_1",
      id_type: "user",
      run_id: RUN_ID,
      variant,
      first_exposure_ts: eventTs,
      first_ingest_ts: ingestTs,
      window_anchor: eventTs,
    });
  }
  return exposures;
}

function anyIngestWatermarkTripsExposureSrm(exposures: readonly DedupeExposureRow[]): boolean {
  const ordered = [...exposures].sort((left, right) => {
    const leftMs = Date.parse(left.first_ingest_ts);
    const rightMs = Date.parse(right.first_ingest_ts);
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
    const keepCount = Math.max(1, Math.floor(ordered.length * fraction));
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: ordered.slice(0, keepCount),
      srm_procedure: "sequential_martingale",
    });
    if (result.srm.srm_is_mismatch) {
      return true;
    }
  }
  return false;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
