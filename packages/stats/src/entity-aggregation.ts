import type { MetricKind, PerEntityMetricRow } from "@splitch/contracts";
import { isPresenceMetric } from "@splitch/contracts";
import { dedupedExposureRowsForVariant } from "./exposure-denominator";
import {
  parseWatermarkMs,
  partitionRetentionExposures,
  retentionHorizonForMetric,
} from "./retention-eligibility";
import type { EntityAggregate, MetricArmEstimateInput } from "./variance-estimator-types";
import { finiteValue } from "./variance-math";

export function aggregateEntitiesWithEligibility(input: MetricArmEstimateInput): {
  entities: EntityAggregate[];
  immatureExcluded: number;
} {
  return seedAndFill(input);
}

function seedAndFill(input: MetricArmEstimateInput): {
  entities: EntityAggregate[];
  immatureExcluded: number;
} {
  const { entities, immatureExcluded } = seedExposedEntities(input);
  for (const row of metricRowsForInput(input)) {
    const entity = entities.get(row.targeting_key_hash);
    if (!entity) {
      continue;
    }
    applyMetricRow(entity, row, input.metric_type);
  }

  return { entities: [...entities.values()], immatureExcluded };
}

/**
 * Cut a list down to the first `sampleSize` items by Exposure time.
 *
 * A fixed-horizon z-test is decision-valid for exactly `sample_size_locked`
 * Entities per arm, and nothing stops Entities accruing past that: hash-bucketed
 * assignment never lands both arms on the same count, and a Run keeps collecting
 * until someone ends it. Analyzing whatever is present would therefore either
 * never reach the horizon or re-test a growing dataset at every poll, which is
 * peeking on a test that has no peeking correction. Truncating by exposure time
 * makes every re-analysis return the same pre-registered test.
 *
 * The lock happens on Exposures *before* Retention maturity filtering so a
 * late-maturing early Entity cannot later displace an already selected one.
 */
function lockByFirstExposure<T>(
  items: T[],
  sampleSize: number | undefined,
  firstExposureTs: (item: T) => string,
  tieBreak: (item: T) => string,
): T[] {
  if (sampleSize === undefined || items.length <= sampleSize) {
    return items;
  }
  return items
    .map((item) => ({ item, ms: exposureMs(firstExposureTs(item)), id: tieBreak(item) }))
    .sort(
      (left, right) =>
        // Entities exposed in the same millisecond still need a total order, or
        // which ones survive truncation would depend on row arrival order.
        left.ms - right.ms || left.id.localeCompare(right.id),
    )
    .slice(0, sampleSize)
    .map((keyed) => keyed.item);
}

function exposureMs(firstExposureTs: string): number {
  const parsed = Date.parse(firstExposureTs);
  if (!Number.isFinite(parsed)) {
    throw new Error(`first_exposure_ts must be an ISO timestamp; got ${firstExposureTs}`);
  }
  return parsed;
}

function seedExposedEntities(input: MetricArmEstimateInput): {
  entities: Map<string, EntityAggregate>;
  immatureExcluded: number;
} {
  // Lock the first-N population *before* maturity filtering. Otherwise a
  // late-maturing early Entity in an Activation-gated Run can later displace
  // an Entity that already entered a decision-valid fixed-horizon sample.
  const locked = lockByFirstExposure(
    [...dedupedExposureRowsForVariant(input)],
    input.fixed_horizon_sample_size,
    (exposure) => exposure.first_exposure_ts,
    (exposure) => exposure.targeting_key_hash,
  );
  const { eligible, immatureExcluded } =
    input.metric_type === "retention"
      ? partitionRetentionExposures(
          locked,
          retentionHorizonForMetric(input, input.metric_id).horizon_end_ms,
          parseWatermarkMs(input.data_watermark, input.metric_id),
        )
      : { eligible: locked, immatureExcluded: 0 };
  const entities = new Map<string, EntityAggregate>();
  for (const exposure of eligible) {
    entities.set(exposure.targeting_key_hash, {
      targeting_key_hash: exposure.targeting_key_hash,
      first_exposure_ts: exposure.first_exposure_ts,
      window_anchor: exposure.window_anchor,
      value: 0,
      num_value: 0,
      denom_value: 0,
      cuped_adjusted: false,
    });
  }
  return { entities, immatureExcluded };
}

function metricRowsForInput(input: MetricArmEstimateInput): PerEntityMetricRow[] {
  return input.metric_values.filter((row) => {
    if (row.run_id !== input.run_id || row.metric_id !== input.metric_id || !row.in_window) {
      return false;
    }
    if (row.metric_type !== input.metric_type) {
      throw new Error(
        `metric ${input.metric_id} mixed ${input.metric_type} and ${row.metric_type}`,
      );
    }
    return true;
  });
}

function applyMetricRow(
  entity: EntityAggregate,
  row: PerEntityMetricRow,
  metricType: MetricKind,
): void {
  if (metricType === "ratio") {
    entity.num_value += finiteValue(row.num_value, "num_value");
    entity.denom_value += finiteValue(row.denom_value, "denom_value");
    return;
  }

  if (isPresenceMetric(metricType)) {
    entity.value = Math.max(entity.value, finiteValue(row.value, "value") > 0 ? 1 : 0);
    return;
  }

  entity.value += finiteValue(row.value, "value");
}
