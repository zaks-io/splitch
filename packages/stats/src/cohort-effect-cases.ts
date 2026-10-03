import type { DedupeExposureRow, PerEntityMetricRow, StatsInput } from "@splitch/contracts";
import { ANALYSIS_V1_VERSION } from "@splitch/contracts";
import { MS_PER_DAY } from "./cohort-effect-types";

export const COHORT_RUN_START = "2026-07-01T00:00:00.000Z";
const COHORT_RUN_ID = "run_cohort_effect";

export interface CohortEntitySpec {
  readonly variant: "control" | "treatment";
  readonly dayOffset: number;
  readonly value: number;
  readonly index: number;
}

export function cohortStatsInput(entities: readonly CohortEntitySpec[]): StatsInput {
  const exposures: DedupeExposureRow[] = [];
  const metric_values: PerEntityMetricRow[] = [];
  for (const entity of entities) {
    const key = `${entity.variant}_${entity.dayOffset}_${entity.index}`;
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
    metric_values.push({
      targeting_key_hash: key,
      run_id: COHORT_RUN_ID,
      metric_id: "conversion",
      metric_type: "binomial",
      value: entity.value,
      in_window: true,
    });
  }
  return {
    run_id: COHORT_RUN_ID,
    analysis_version: ANALYSIS_V1_VERSION,
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [{ metric_id: "conversion", variant: "treatment" }],
    guardrail_decisions: [],
    metric_variance_config: [],
    exposures,
    metric_values,
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

export function isoDaysAfter(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * MS_PER_DAY).toISOString();
}
