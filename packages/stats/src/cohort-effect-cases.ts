import type {
  ActivationRow,
  CupedCovariateRow,
  DedupeExposureRow,
  MetricKind,
  MetricVarianceConfig,
  PerEntityMetricRow,
  StatsInput,
} from "@splitch/contracts";
import { ANALYSIS_V1_VERSION } from "@splitch/contracts";
import { MS_PER_DAY } from "./cohort-effect-types";

export const COHORT_RUN_START = "2026-07-01T00:00:00.000Z";
const COHORT_RUN_ID = "run_cohort_effect";

export interface CohortEntitySpec {
  readonly variant: "control" | "treatment";
  readonly dayOffset: number;
  readonly value: number;
  readonly index: number;
  readonly numValue?: number;
  readonly denomValue?: number;
  readonly prePeriodValue?: number;
}

export interface CohortStatsInputOptions {
  readonly metricId?: string;
  readonly metricType?: MetricKind;
  readonly metricVarianceConfig?: readonly MetricVarianceConfig[];
  readonly activationRows?: readonly ActivationRow[];
  readonly prePeriodCovariates?: readonly CupedCovariateRow[];
}

export function cohortStatsInput(
  entities: readonly CohortEntitySpec[],
  options: CohortStatsInputOptions = {},
): StatsInput {
  const metricId = options.metricId ?? "conversion";
  const metricType = options.metricType ?? "binomial";
  const { exposures, metric_values } = rowsForEntities(entities, metricId, metricType);
  return {
    run_id: COHORT_RUN_ID,
    analysis_version: ANALYSIS_V1_VERSION,
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [{ metric_id: metricId, variant: "treatment" }],
    guardrail_decisions: [],
    metric_variance_config: [...(options.metricVarianceConfig ?? [])],
    exposures,
    metric_values,
    ...(options.activationRows !== undefined
      ? { activation_rows: [...options.activationRows] }
      : {}),
    ...(options.prePeriodCovariates !== undefined
      ? { pre_period_covariates: [...options.prePeriodCovariates] }
      : {}),
  };
}

/** Balanced arms: `perArm` Entities per variant in each listed day offset. */
export function balancedEntities(
  dayOffsets: readonly number[],
  perArm: number,
  controlRate: number,
  treatmentRate: number,
): CohortEntitySpec[] {
  const entities: CohortEntitySpec[] = [];
  for (const dayOffset of dayOffsets) {
    for (let index = 0; index < perArm; index += 1) {
      entities.push({
        variant: "control",
        dayOffset,
        index,
        value: index < Math.round(controlRate * perArm) ? 1 : 0,
      });
      entities.push({
        variant: "treatment",
        dayOffset,
        index,
        value: index < Math.round(treatmentRate * perArm) ? 1 : 0,
      });
    }
  }
  return entities;
}

export function entityKey(
  entity: Pick<CohortEntitySpec, "variant" | "dayOffset" | "index">,
): string {
  return `${entity.variant}_${entity.dayOffset}_${entity.index}`;
}

export function activationForEntities(
  entities: readonly CohortEntitySpec[],
  options: { readonly activatedIndexes?: ReadonlySet<number>; readonly activateAll?: boolean } = {},
): ActivationRow[] {
  return entities
    .filter((entity) => options.activateAll === true || options.activatedIndexes?.has(entity.index))
    .map((entity) => ({
      targeting_key_hash: entityKey(entity),
      run_id: COHORT_RUN_ID,
      activation_ts: isoDaysAfter(COHORT_RUN_START, entity.dayOffset + 0.01),
      counterfactual: false,
      activated: true,
    }));
}

export function prePeriodForEntities(
  entities: readonly CohortEntitySpec[],
  metricId: string,
): CupedCovariateRow[] {
  return entities
    .filter((entity) => entity.prePeriodValue !== undefined)
    .map((entity) => ({
      targeting_key_hash: entityKey(entity),
      metric_id: metricId,
      pre_period_value: entity.prePeriodValue ?? 0,
      covariate_source: "pre_period" as const,
    }));
}

function rowsForEntities(
  entities: readonly CohortEntitySpec[],
  metricId: string,
  metricType: MetricKind,
): { exposures: DedupeExposureRow[]; metric_values: PerEntityMetricRow[] } {
  const exposures: DedupeExposureRow[] = [];
  const metric_values: PerEntityMetricRow[] = [];
  for (const entity of entities) {
    const key = entityKey(entity);
    const ts = isoDaysAfter(COHORT_RUN_START, entity.dayOffset);
    exposures.push({
      app_id: "app_1",
      targeting_key_hash: key,
      environment_id: "env_1",
      id_type: "user",
      run_id: COHORT_RUN_ID,
      variant: entity.variant,
      first_exposure_ts: ts,
      window_anchor: ts,
    });
    metric_values.push(metricRowForEntity(entity, key, metricId, metricType));
  }
  return { exposures, metric_values };
}

function metricRowForEntity(
  entity: CohortEntitySpec,
  key: string,
  metricId: string,
  metricType: MetricKind,
): PerEntityMetricRow {
  const ratioFields =
    entity.numValue !== undefined || entity.denomValue !== undefined
      ? {
          num_value: entity.numValue ?? entity.value,
          denom_value: entity.denomValue ?? 0,
        }
      : {};
  return {
    targeting_key_hash: key,
    run_id: COHORT_RUN_ID,
    metric_id: metricId,
    metric_type: metricType,
    value: entity.value,
    ...ratioFields,
    in_window: true,
  };
}

function isoDaysAfter(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * MS_PER_DAY).toISOString();
}
