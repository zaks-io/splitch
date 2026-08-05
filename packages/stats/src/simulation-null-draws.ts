import type { DedupeExposureRow, MetricKind, PerEntityMetricRow } from "@splitch/contracts";

/**
 * A null experiment expressed as the rows the engine actually reads.
 *
 * The Type-I certification used to hand the CI adapters a sampling variance it
 * computed itself, which certified the adapters in isolation and left the layer
 * that feeds them in production (aggregation, winsorization, the per-arm
 * variance, the absolute-lift composition) uncertified. Emitting rows means the
 * simulation exercises `estimateMetricComparison` on the way to the adapter, so
 * the bound covers the composition a Run is actually decided by.
 */

export const SIMULATION_RUN_ID = "run_simulation_null";
export const SIMULATION_METRIC_ID = "metric_simulation_null";
export const SIMULATION_CONTROL_VARIANT = "control";
export const SIMULATION_TREATMENT_VARIANT = "treatment";

/**
 * `count` is the additive continuous kind, so a draw runs the pooled
 * winsorization and sample-variance path rather than the Binomial shortcut.
 */
export const SIMULATION_METRIC_TYPE: MetricKind = "count";

const SIMULATION_TS = "2026-01-01T00:00:00.000Z";
const ARMS = [SIMULATION_TREATMENT_VARIANT, SIMULATION_CONTROL_VARIANT] as const;

export interface NullExperimentDraw {
  readonly exposures: readonly DedupeExposureRow[];
  readonly metricValues: readonly PerEntityMetricRow[];
}

/**
 * Both arms drawn from the same distribution, interleaved one entity per arm,
 * so the first `2 * size` rows are exactly what a look at `size` per arm saw.
 */
export function drawNullExperiment(rng: () => number, size: number): NullExperimentDraw {
  const exposures: DedupeExposureRow[] = [];
  const metricValues: PerEntityMetricRow[] = [];

  for (let index = 0; index < size; index += 1) {
    for (const variant of ARMS) {
      const targetingKeyHash = `${variant}_${index}`;
      exposures.push(exposureRow(variant, targetingKeyHash));
      metricValues.push(metricRow(targetingKeyHash, rng()));
    }
  }

  return { exposures, metricValues };
}

/** The prefix of a draw a look at `size` entities per arm would have read. */
export function lookAt(draw: NullExperimentDraw, size: number): NullExperimentDraw {
  const rows = size * ARMS.length;
  return {
    exposures: draw.exposures.slice(0, rows),
    metricValues: draw.metricValues.slice(0, rows),
  };
}

function exposureRow(variant: string, targetingKeyHash: string): DedupeExposureRow {
  return {
    app_id: "app_simulation",
    targeting_key_hash: targetingKeyHash,
    environment_id: "env_simulation",
    id_type: "user",
    run_id: SIMULATION_RUN_ID,
    variant,
    first_exposure_ts: SIMULATION_TS,
    window_anchor: SIMULATION_TS,
  };
}

function metricRow(targetingKeyHash: string, value: number): PerEntityMetricRow {
  return {
    targeting_key_hash: targetingKeyHash,
    run_id: SIMULATION_RUN_ID,
    metric_id: SIMULATION_METRIC_ID,
    metric_type: SIMULATION_METRIC_TYPE,
    value,
    in_window: true,
  };
}

export function seededNormal(seed: string): () => number {
  const uniform = mulberry32(fnv1a(seed));
  let spare: number | undefined;

  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }

    const first = Math.max(Number.MIN_VALUE, uniform());
    const second = uniform();
    const radius = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
