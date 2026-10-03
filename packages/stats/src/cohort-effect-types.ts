import type { CohortEffectBucketId, StatsInput } from "@splitch/contracts";

/**
 * Constants and input for the first-exposure-day cohort-effect diagnostic
 * (plan 2.8). Metric values are one aggregate per Entity, so buckets group
 * Entities by first_exposure day relative to Run start — not a per-day outcome
 * series and not a Segment.
 */

export const COHORT_EFFECT_BUCKET_IDS = [
  "day_0",
  "days_1_6",
  "day_7_plus",
] as const satisfies readonly CohortEffectBucketId[];

/** Two-sided Type I level for the early-vs-late novelty z test. */
export const COHORT_EFFECT_NOVELTY_ALPHA = 0.05;

/**
 * Minimum Entities per arm in both the earliest bucket and the later pooled
 * set before the novelty flag may leave `insufficient_data`.
 */
export const COHORT_EFFECT_MIN_ARM_N = 30;

export const MS_PER_DAY = 86_400_000;

export interface CohortEffectComputeInput {
  readonly statsInput: StatsInput;
  /** ISO Run start used as day-0 origin for first_exposure bucketing. */
  readonly runStartedAt: string;
  readonly noveltyAlpha?: number;
  readonly minArmN?: number;
}
