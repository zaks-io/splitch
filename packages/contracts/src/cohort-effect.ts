import { z } from "zod";
import { MetricRefSchema } from "./leaf-schemas-experiment";

/**
 * Wire shape for the first-exposure-day cohort-effect diagnostic (plan 2.8).
 *
 * Optional on Analysis and detailed Results so Control Plane can deploy before
 * Analysis emits the field. Diagnostic only: never enters the decision gate or
 * result token.
 */

const MetricIdSchema = MetricRefSchema.shape.metricId;

export const cohortEffectBucketIds = ["day_0", "days_1_6", "day_7_plus"] as const;
export const CohortEffectBucketIdSchema = z.enum(cohortEffectBucketIds);
export type CohortEffectBucketId = z.infer<typeof CohortEffectBucketIdSchema>;

export const cohortEffectBucketStatuses = [
  "ready",
  "insufficient_n",
  /** Identical constant outcomes (or a zero-conversion Binomial bucket): point estimate only. */
  "zero_variance",
  /** Ratio Metric with enough Entities but zero mean denominator. */
  "insufficient_denominator",
  /**
   * Sampling variance is negative after the permitted floating-point clamp.
   * Distinct from exact-zero `zero_variance`.
   */
  "numerical_failure",
] as const;
export const CohortEffectBucketStatusSchema = z.enum(cohortEffectBucketStatuses);
export type CohortEffectBucketStatus = z.infer<typeof CohortEffectBucketStatusSchema>;

export const CohortEffectBucketSchema = z
  .object({
    bucket: CohortEffectBucketIdSchema,
    n_control: z.number().int().nonnegative(),
    n_treatment: z.number().int().nonnegative(),
    absolute_effect: z.number().finite().nullable(),
    absolute_ci_lower: z.number().finite().nullable(),
    absolute_ci_upper: z.number().finite().nullable(),
    status: CohortEffectBucketStatusSchema,
  })
  .strict();
export type CohortEffectBucket = z.infer<typeof CohortEffectBucketSchema>;

export const noveltyFlags = ["detected", "not_detected", "insufficient_data"] as const;
export const NoveltyFlagSchema = z.enum(noveltyFlags);
export type NoveltyFlag = z.infer<typeof NoveltyFlagSchema>;

export const CohortEffectNoveltySchema = z
  .object({
    flag: NoveltyFlagSchema,
    /** Two-sided Type I level used for the early-vs-late z test. */
    alpha: z.number().gt(0).lt(1),
    z_statistic: z.number().finite().optional(),
    p_value: z.number().finite().min(0).max(1).optional(),
  })
  .strict();
export type CohortEffectNovelty = z.infer<typeof CohortEffectNoveltySchema>;

export const CohortEffectComparisonSchema = z
  .object({
    treatment_variant: z.string().min(1),
    buckets: z.array(CohortEffectBucketSchema).length(cohortEffectBucketIds.length),
    novelty: CohortEffectNoveltySchema,
  })
  .strict();
export type CohortEffectComparison = z.infer<typeof CohortEffectComparisonSchema>;

export const cohortEffectUnavailableReasons = [
  "no_primary_metric",
  "ambiguous_primary_metric",
  "no_treatment_variant",
  "insufficient_entities",
] as const;
export const CohortEffectUnavailableReasonSchema = z.enum(cohortEffectUnavailableReasons);
export type CohortEffectUnavailableReason = z.infer<typeof CohortEffectUnavailableReasonSchema>;

export const CohortEffectDiagnosticSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      metric_id: MetricIdSchema,
      /**
       * Per-Entity Metric values are one aggregate per Entity, not a per-day
       * series. Buckets therefore group Entities by first_exposure day relative
       * to Run start (arrival cohort), not days-since-exposure outcome paths.
       */
      grouping: z.literal("first_exposure_day_vs_run_start"),
      comparisons: z.array(CohortEffectComparisonSchema).min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: CohortEffectUnavailableReasonSchema,
    })
    .strict(),
]);
export type CohortEffectDiagnostic = z.infer<typeof CohortEffectDiagnosticSchema>;
