import type { DedupeExposureRow, MetricKind, PerEntityMetricRow } from "@splitch/contracts";
import type { CupedCovariateRow } from "./variance-estimator-types";

export const FIELLER_RUN_ID = "run_fieller_coverage";
export const FIELLER_METRIC_ID = "metric_fieller_coverage";
export const FIELLER_CONTROL = "control";
export const FIELLER_TREATMENT = "treatment";

const TS = "2026-01-01T00:00:00.000Z";
const PRE_TS = "2025-12-01T00:00:00.000Z";
const ARMS = [FIELLER_CONTROL, FIELLER_TREATMENT] as const;

type RelativeMetricKind = Extract<MetricKind, "binomial" | "count" | "revenue" | "ratio">;

export interface RelativeDrawSpec {
  readonly kind: RelativeMetricKind;
  /** Binomial rate, additive mean, revenue arithmetic mean, or Ratio numerator mean. */
  readonly controlMean: number;
  readonly treatmentMean: number;
  readonly cuped: boolean;
  readonly spread?: number;
  readonly logSigma?: number;
  readonly denomMean?: number;
  readonly correlation?: number;
}

export interface RelativeExperimentDraw {
  readonly spec: RelativeDrawSpec;
  readonly exposures: readonly DedupeExposureRow[];
  readonly metricValues: readonly PerEntityMetricRow[];
  readonly covariates: readonly CupedCovariateRow[];
}

/**
 * Nonzero true lifts only. Fieller's inclusion of 0% reduces to the absolute
 * null test, so a zero-lift fixture cannot catch a relative-bound scaling bug
 * that still covers zero. Positive and negative ±20% cover both sides.
 */
export function coverageScenarios(): readonly RelativeDrawSpec[] {
  return [
    { kind: "binomial", controlMean: 0.25, treatmentMean: 0.3, cuped: false },
    { kind: "binomial", controlMean: 0.25, treatmentMean: 0.2, cuped: false },
    {
      kind: "binomial",
      controlMean: 0.25,
      treatmentMean: 0.3,
      cuped: true,
      correlation: 0.7,
    },
    {
      kind: "binomial",
      controlMean: 0.25,
      treatmentMean: 0.2,
      cuped: true,
      correlation: 0.7,
    },
    { kind: "count", controlMean: 10, treatmentMean: 12, cuped: false },
    { kind: "count", controlMean: 10, treatmentMean: 8, cuped: false },
    { kind: "count", controlMean: 10, treatmentMean: 12, cuped: true },
    { kind: "count", controlMean: 10, treatmentMean: 8, cuped: true },
    { kind: "revenue", controlMean: 10, treatmentMean: 12, cuped: false, logSigma: 1.2 },
    { kind: "revenue", controlMean: 10, treatmentMean: 8, cuped: false, logSigma: 1.2 },
    { kind: "revenue", controlMean: 10, treatmentMean: 12, cuped: true, logSigma: 1.2 },
    { kind: "revenue", controlMean: 10, treatmentMean: 8, cuped: true, logSigma: 1.2 },
    { kind: "ratio", controlMean: 4, treatmentMean: 4.8, cuped: false, denomMean: 8 },
    { kind: "ratio", controlMean: 4, treatmentMean: 3.2, cuped: false, denomMean: 8 },
  ];
}

export function coverageScenarioKey(spec: RelativeDrawSpec): string {
  const lift = trueRelativeLiftPct(spec);
  if (lift === null) {
    throw new Error("coverage fixtures require a defined true relative lift.");
  }
  const rounded = Math.round(lift);
  if (rounded === 0) {
    throw new Error("coverage fixtures require a nonzero true relative lift.");
  }
  const sign = rounded > 0 ? "plus" : "minus";
  return `${spec.kind}:${spec.cuped ? "cuped" : "raw"}:${sign}${Math.abs(rounded)}`;
}

export function guardrailSpec(fixture: "known-safe" | "known-harmful"): RelativeDrawSpec {
  return {
    kind: "count",
    controlMean: 10,
    treatmentMean: fixture === "known-safe" ? 10 : 8,
    cuped: true,
  };
}

export function trueRelativeLiftPct(spec: RelativeDrawSpec): number | null {
  if (spec.kind === "ratio") {
    const denom = spec.denomMean ?? 8;
    return (spec.treatmentMean / denom / (spec.controlMean / denom) - 1) * 100;
  }
  if (spec.controlMean === 0) {
    return null;
  }
  return (spec.treatmentMean / spec.controlMean - 1) * 100;
}

export function drawRelativeExperiment(
  uniform: () => number,
  gaussian: () => number,
  spec: RelativeDrawSpec,
  size: number,
): RelativeExperimentDraw {
  const exposures: DedupeExposureRow[] = [];
  const metricValues: PerEntityMetricRow[] = [];
  const covariates: CupedCovariateRow[] = [];

  for (let index = 0; index < size; index += 1) {
    for (const variant of ARMS) {
      const targetingKeyHash = `${variant}_${index}`;
      const mean = variant === FIELLER_CONTROL ? spec.controlMean : spec.treatmentMean;
      const entity = drawEntity(uniform, gaussian, spec, mean);
      exposures.push(exposureRow(variant, targetingKeyHash));
      pushMetricRow(metricValues, targetingKeyHash, spec.kind, entity);
      if (spec.cuped && entity.covariate !== null) {
        covariates.push({
          targeting_key_hash: targetingKeyHash,
          metric_id: FIELLER_METRIC_ID,
          pre_period_value: entity.covariate,
          covariate_source: "pre_period",
          observed_at: PRE_TS,
        });
      }
    }
  }

  return { spec, exposures, metricValues, covariates };
}

export function lookAtRelative(draw: RelativeExperimentDraw, size: number): RelativeExperimentDraw {
  const rows = size * ARMS.length;
  return {
    spec: draw.spec,
    exposures: draw.exposures.slice(0, rows),
    metricValues: sliceMetricValues(draw, rows),
    covariates: draw.covariates.slice(0, rows),
  };
}

export function seededUniform(seed: string): () => number {
  return mulberry32(fnv1a(seed));
}

export function gaussianFromUniform(uniform: () => number): () => number {
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

interface EntityOutcome {
  readonly value: number;
  readonly num: number;
  readonly denom: number;
  readonly covariate: number | null;
}

function drawEntity(
  uniform: () => number,
  gaussian: () => number,
  spec: RelativeDrawSpec,
  mean: number,
): EntityOutcome {
  const correlation = spec.correlation ?? 0.6;
  if (spec.kind === "binomial") {
    return drawBinomial(uniform, spec.cuped, mean, correlation, spec.controlMean);
  }
  if (spec.kind === "ratio") {
    const denomMean = spec.denomMean ?? 8;
    return {
      value: 0,
      num: mean * Math.exp(0.2 * gaussian()),
      denom: denomMean * Math.exp(0.2 * gaussian()),
      covariate: null,
    };
  }
  if (spec.kind === "revenue") {
    return drawRevenue(gaussian, spec, mean, correlation);
  }
  return drawCount(gaussian, spec, mean, correlation);
}

/**
 * Shared-rate pre-period covariate so CUPED stays exchangeable across arms.
 * When the outcome copies the covariate with probability `agreement`, the free
 * Bernoulli rate is solved so E[value] still equals the arm mean. Drawing the
 * covariate from the arm mean itself would erase a nonzero treatment effect.
 */
function drawBinomial(
  uniform: () => number,
  cuped: boolean,
  rate: number,
  agreement: number,
  covariateRate: number,
): EntityOutcome {
  if (!cuped) {
    return { value: uniform() < rate ? 1 : 0, num: 0, denom: 0, covariate: null };
  }
  const freeRate = freeBernoulliRate(rate, covariateRate, agreement);
  const covariate = uniform() < covariateRate ? 1 : 0;
  const value = uniform() < agreement ? covariate : uniform() < freeRate ? 1 : 0;
  return { value, num: 0, denom: 0, covariate };
}

function freeBernoulliRate(rate: number, covariateRate: number, agreement: number): number {
  if (!(agreement > 0) || !(agreement < 1)) {
    throw new Error(`binomial CUPED agreement must be in (0, 1), got ${agreement}.`);
  }
  const freeRate = (rate - agreement * covariateRate) / (1 - agreement);
  if (!(freeRate >= 0) || !(freeRate <= 1)) {
    throw new Error(
      `binomial CUPED cannot preserve mean ${rate} with covariate rate ${covariateRate} and agreement ${agreement}.`,
    );
  }
  return freeRate;
}

function drawCount(
  gaussian: () => number,
  spec: RelativeDrawSpec,
  mean: number,
  correlation: number,
): EntityOutcome {
  const spread = spec.spread ?? 3;
  const covariate = gaussian();
  const noise = Math.sqrt(1 - correlation ** 2) * gaussian();
  const value = spec.cuped
    ? mean + spread * (correlation * covariate + noise)
    : mean + spread * gaussian();
  return { value, num: 0, denom: 0, covariate: spec.cuped ? covariate : null };
}

function drawRevenue(
  gaussian: () => number,
  spec: RelativeDrawSpec,
  mean: number,
  correlation: number,
): EntityOutcome {
  const sigma = spec.logSigma ?? 1.2;
  const logMean = Math.log(mean) - 0.5 * sigma ** 2;
  const covariate = gaussian();
  const shock = spec.cuped
    ? correlation * covariate + Math.sqrt(1 - correlation ** 2) * gaussian()
    : gaussian();
  return {
    value: Math.exp(logMean + sigma * shock),
    num: 0,
    denom: 0,
    covariate: spec.cuped ? covariate : null,
  };
}

function pushMetricRow(
  rows: PerEntityMetricRow[],
  targetingKeyHash: string,
  kind: RelativeMetricKind,
  entity: EntityOutcome,
): void {
  if (kind === "binomial" && entity.value === 0) {
    return;
  }
  rows.push({
    targeting_key_hash: targetingKeyHash,
    run_id: FIELLER_RUN_ID,
    metric_id: FIELLER_METRIC_ID,
    metric_type: kind,
    value: entity.value,
    ...(kind === "ratio" ? { num_value: entity.num, denom_value: entity.denom } : {}),
    in_window: true,
  });
}

function sliceMetricValues(draw: RelativeExperimentDraw, entityRows: number): PerEntityMetricRow[] {
  const allowed = new Set(draw.exposures.slice(0, entityRows).map((row) => row.targeting_key_hash));
  return draw.metricValues.filter((row) => allowed.has(row.targeting_key_hash));
}

function exposureRow(variant: string, targetingKeyHash: string): DedupeExposureRow {
  return {
    app_id: "app_fieller",
    targeting_key_hash: targetingKeyHash,
    environment_id: "env_fieller",
    id_type: "user",
    run_id: FIELLER_RUN_ID,
    variant,
    first_exposure_ts: TS,
    first_ingest_ts: TS,
    window_anchor: TS,
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
