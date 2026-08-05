import type { DedupeExposureRow, PerEntityMetricRow, StatsInput } from "@splitch/contracts";

const RUN_ID = "run_relative_ci";
const TS = "2026-07-01T00:00:00.000Z";

export const ALPHA = 0.05;

export interface CountArmShape {
  readonly controlMean: number;
  readonly treatmentMean: number;
  readonly spread: number;
  readonly n: number;
  readonly guardrailThreshold?: number;
}

export function binomialStatsInput(
  control: readonly number[],
  treatment: readonly number[],
  horizon: "fixed" | "sequential",
): StatsInput {
  const rows = emptyRows();
  const controlTotal = control[0] ?? 0;
  const treatmentTotal = treatment[0] ?? 0;

  addBinomialArm(rows, "control", controlTotal, control[1] ?? 0);
  addBinomialArm(rows, "treatment", treatmentTotal, treatment[1] ?? 0);

  return statsInput(rows, horizon, controlTotal, controlTotal + treatmentTotal);
}

export function countStatsInput(random: () => number, shape: CountArmShape): StatsInput {
  const rows = emptyRows();

  addCountArm(rows, random, "control", shape.controlMean, shape);
  addCountArm(rows, random, "treatment", shape.treatmentMean, shape);

  return {
    ...statsInput(rows, "fixed", shape.n, shape.n * 2),
    guardrail_decisions:
      shape.guardrailThreshold === undefined
        ? []
        : [
            {
              metric_id: "conversion",
              variant: "treatment",
              downside_threshold: shape.guardrailThreshold,
              guardrail_locked_at_run_start: true,
              threshold_locked_at_run_start: true,
            },
          ],
  };
}

export function randomBetween(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Rows {
  readonly exposures: DedupeExposureRow[];
  readonly metricValues: PerEntityMetricRow[];
}

function emptyRows(): Rows {
  return { exposures: [], metricValues: [] };
}

function statsInput(
  rows: Rows,
  horizon: "fixed" | "sequential",
  sampleSizeLocked: number,
  targetN: number,
): StatsInput {
  return {
    run_id: RUN_ID,
    confidence_level: 1 - ALPHA,
    horizon,
    ...(horizon === "sequential"
      ? { target_n: targetN }
      : { sample_size_locked: sampleSizeLocked }),
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [{ metric_id: "conversion", variant: "treatment" }],
    guardrail_decisions: [],
    metric_variance_config: [],
    exposures: rows.exposures,
    metric_values: rows.metricValues,
  };
}

function addBinomialArm(rows: Rows, variant: string, total: number, conversions: number): void {
  for (let index = 0; index < total; index += 1) {
    const targetingKeyHash = expose(rows, variant, index);
    if (index < conversions) {
      rows.metricValues.push(metricRow(targetingKeyHash, "binomial", 1));
    }
  }
}

function addCountArm(
  rows: Rows,
  random: () => number,
  variant: string,
  mean: number,
  shape: CountArmShape,
): void {
  for (let index = 0; index < shape.n; index += 1) {
    const targetingKeyHash = expose(rows, variant, index);
    const value = mean + shape.spread * standardNormal(random);
    rows.metricValues.push(metricRow(targetingKeyHash, "count", value));
  }
}

function expose(rows: Rows, variant: string, index: number): string {
  const targetingKeyHash = `${variant}_${index}`;
  rows.exposures.push({
    app_id: "app_1",
    targeting_key_hash: targetingKeyHash,
    environment_id: "env_1",
    id_type: "user",
    run_id: RUN_ID,
    variant,
    first_exposure_ts: TS,
    window_anchor: TS,
  });
  return targetingKeyHash;
}

function metricRow(
  targetingKeyHash: string,
  metricType: "binomial" | "count",
  value: number,
): PerEntityMetricRow {
  return {
    targeting_key_hash: targetingKeyHash,
    run_id: RUN_ID,
    metric_id: "conversion",
    metric_type: metricType,
    value,
    in_window: true,
  };
}

function standardNormal(random: () => number): number {
  const u = Math.max(random(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
