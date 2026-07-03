import type { MetricKind, VarianceTechniques, WinsorizeCap } from "@splitch/contracts";
import type {
  CupedAdjustment,
  EntityAggregate,
  MetricComparisonEstimateInput,
} from "./variance-estimator-types.js";

const DEFAULT_WINSORIZE_PCT = 99.9;
const ADDITIVE_METRIC_TYPES = new Set<MetricKind>(["count", "revenue", "ratio"]);

export interface PooledWinsorization {
  readonly pct: number;
  readonly cap: WinsorizeCap;
}

export function computePooledWinsorization(
  input: Pick<
    MetricComparisonEstimateInput,
    "metric_type" | "winsorize" | "winsorize_pct" | "metric_id"
  >,
  entities: readonly EntityAggregate[],
): PooledWinsorization | null {
  if (input.winsorize === false || !ADDITIVE_METRIC_TYPES.has(input.metric_type)) {
    return null;
  }
  if (entities.length === 0) {
    return null;
  }

  const pct = winsorizePct(input.winsorize_pct ?? DEFAULT_WINSORIZE_PCT, input.metric_id);
  if (input.metric_type === "ratio") {
    return {
      pct,
      cap: {
        num_value: percentileCap(
          entities.map((entity) => entity.num_value),
          pct,
        ),
        denom_value: percentileCap(
          entities.map((entity) => entity.denom_value),
          pct,
        ),
      },
    };
  }

  return {
    pct,
    cap: percentileCap(
      entities.map((entity) => entity.value),
      pct,
    ),
  };
}

export function winsorizedEntities(
  metricType: MetricKind,
  entities: readonly EntityAggregate[],
  winsorization: PooledWinsorization | null,
): EntityAggregate[] {
  if (!winsorization) {
    return [...entities];
  }

  if (metricType === "ratio") {
    if (typeof winsorization.cap === "number") {
      throw new Error("ratio winsorization requires numerator and denominator caps.");
    }
    const cap = winsorization.cap;
    return entities.map((entity) => ({
      ...entity,
      num_value: Math.min(entity.num_value, cap.num_value),
      denom_value: Math.min(entity.denom_value, cap.denom_value),
    }));
  }

  if (typeof winsorization.cap !== "number") {
    throw new Error(`${metricType} winsorization requires a scalar cap.`);
  }
  const cap = winsorization.cap;

  return entities.map((entity) => ({
    ...entity,
    value: Math.min(entity.value, cap),
  }));
}

export function varianceTechniquesFor(
  metricType: MetricKind,
  winsorization: PooledWinsorization | null,
  cuped?: CupedAdjustment,
): VarianceTechniques {
  return {
    winsorized: winsorization !== null,
    winsorize_pct: winsorization?.pct ?? null,
    winsorize_cap: winsorization?.cap ?? null,
    cuped_applied: cuped?.method !== undefined && cuped.method !== "none",
    cuped_method: cuped?.method ?? null,
    cuped_attribute: cuped?.attribute ?? null,
    cuped_attribute_source: cuped?.attributeSource ?? null,
    cuped_coverage_pct: cuped?.coveragePct ?? null,
    delta_method: metricType === "ratio",
  };
}

export function noVarianceTechniques(metricType: MetricKind): VarianceTechniques {
  return varianceTechniquesFor(metricType, null);
}

function winsorizePct(pct: number, metricId: string): number {
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new Error(`metric ${metricId} winsorize_pct must be > 0 and <= 100.`);
  }
  return pct;
}

function percentileCap(values: readonly number[], pct: number): number {
  if (values.length === 0) {
    throw new Error("winsorization requires at least one value.");
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1),
  );
  const cap = sorted[index];
  if (cap === undefined) {
    throw new Error("winsorization failed to select a cap.");
  }
  return cap;
}
