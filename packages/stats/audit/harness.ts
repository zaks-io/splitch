import type { DedupeExposureRow, MetricKind, PerEntityMetricRow } from "@splitch/contracts";

export const RUN_ID = "run_audit";
export const METRIC_ID = "metric_audit";
const CONTROL = "control";
const TREATMENT = "treatment";
const TS = "2026-01-01T00:00:00.000Z";
const PRE_TS = "2025-12-01T00:00:00.000Z";

/** xoshiro-style PRNG independent of anything in packages/stats. */
export function rng(seed: number): () => number {
  let s0 = seed >>> 0 || 1;
  // Math.imul, not `*`: the seeds here run to eight digits and the exact product
  // exceeds 2^53, so a float multiply drops the low bits the mix depends on.
  let s1 = Math.imul(seed, 2654435761) >>> 0 || 2;
  return () => {
    s1 ^= s0;
    s0 = ((s0 << 26) | (s0 >>> 6)) ^ s1 ^ (s1 << 9);
    s1 = (s1 << 13) | (s1 >>> 19);
    return ((s0 + s1) >>> 0) / 4294967296;
  };
}

export function normalDraws(next: () => number): () => number {
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }
    const u = Math.max(1e-300, next());
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export interface ArmData {
  readonly variant: string;
  readonly values: readonly number[];
  readonly nums?: readonly number[];
  readonly denoms?: readonly number[];
}

/**
 * Entities arrive one second apart, in index order, so an arm has a real
 * exposure order. A single shared timestamp would leave fixed-horizon truncation
 * to break ties on the key hash, which is not the order a live Run accrues in.
 */
export function exposuresFor(arms: readonly ArmData[]): DedupeExposureRow[] {
  const rows: DedupeExposureRow[] = [];
  for (const arm of arms) {
    for (let index = 0; index < arm.values.length; index += 1) {
      const ts = new Date(Date.parse(TS) + index * 1000).toISOString();
      rows.push({
        app_id: "app_audit",
        targeting_key_hash: `${arm.variant}_${index}`,
        environment_id: "env_audit",
        id_type: "user",
        run_id: RUN_ID,
        variant: arm.variant,
        first_exposure_ts: ts,
        window_anchor: ts,
      });
    }
  }
  return rows;
}

export function metricRowsFor(
  arms: readonly ArmData[],
  metricType: MetricKind,
): PerEntityMetricRow[] {
  const rows: PerEntityMetricRow[] = [];
  for (const arm of arms) {
    for (let index = 0; index < arm.values.length; index += 1) {
      const base = {
        targeting_key_hash: `${arm.variant}_${index}`,
        run_id: RUN_ID,
        metric_id: METRIC_ID,
        metric_type: metricType,
        in_window: true as const,
      };
      if (metricType === "ratio") {
        rows.push({
          ...base,
          value: 0,
          num_value: arm.nums?.[index] ?? 0,
          denom_value: arm.denoms?.[index] ?? 0,
        });
        continue;
      }
      const value = arm.values[index] ?? 0;
      if (metricType === "binomial" && value === 0) {
        continue; // an absent row is a non-converter
      }
      rows.push({ ...base, value });
    }
  }
  return rows;
}

export function comparisonInput(
  controlValues: readonly number[],
  treatmentValues: readonly number[],
  metricType: MetricKind,
  extra: Record<string, unknown> = {},
) {
  const arms: ArmData[] = [
    { variant: CONTROL, values: controlValues },
    { variant: TREATMENT, values: treatmentValues },
  ];
  return {
    run_id: RUN_ID,
    metric_id: METRIC_ID,
    metric_type: metricType,
    control_variant: CONTROL,
    treatment_variant: TREATMENT,
    exposures: exposuresFor(arms),
    metric_values: metricRowsFor(arms, metricType),
    ...extra,
  };
}

export function ratioComparisonInput(
  control: { nums: readonly number[]; denoms: readonly number[] },
  treatment: { nums: readonly number[]; denoms: readonly number[] },
) {
  const arms: ArmData[] = [
    {
      variant: CONTROL,
      values: control.nums.map(() => 0),
      nums: control.nums,
      denoms: control.denoms,
    },
    {
      variant: TREATMENT,
      values: treatment.nums.map(() => 0),
      nums: treatment.nums,
      denoms: treatment.denoms,
    },
  ];
  return {
    run_id: RUN_ID,
    metric_id: METRIC_ID,
    metric_type: "ratio" as MetricKind,
    control_variant: CONTROL,
    treatment_variant: TREATMENT,
    exposures: exposuresFor(arms),
    metric_values: metricRowsFor(arms, "ratio"),
  };
}

export function prePeriodCovariates(
  controlX: readonly number[],
  treatmentX: readonly number[],
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [variant, values] of [
    [CONTROL, controlX],
    [TREATMENT, treatmentX],
  ] as const) {
    for (let index = 0; index < values.length; index += 1) {
      rows.push({
        targeting_key_hash: `${variant}_${index}`,
        metric_id: METRIC_ID,
        pre_period_value: values[index] ?? 0,
        covariate_source: "pre_period",
        observed_at: PRE_TS,
      });
    }
  }
  return rows;
}

/** Wilson score interval for a Monte Carlo rejection rate. */
export function wilson(successes: number, trials: number, z = 3): [number, number] {
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denom;
  return [center - half, center + half];
}
