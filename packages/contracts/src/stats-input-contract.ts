import { z } from "zod";
import { MetricKindSchema, MetricRefSchema } from "./leaf-schemas-experiment";
import { ANALYSIS_V1_VERSION } from "./run-commitments";
import { PreRegistrationSchema } from "./run-preregistration";
import { CupedAttributeSourceSchema } from "./stats-result-arm";
import { DimensionClassSchema } from "./stats-result-contract";

const MetricIdSchema = MetricRefSchema.shape.metricId;
const TimestampSchema = z.string();
const IntegerSchema = z.number().int();
const ALLOCATION_SUM = 100;
const ALLOCATION_EPSILON = 1e-6;

const AllocationSchema = z.record(z.string(), z.number().min(0).max(100)).refine(
  (allocation) => {
    const sum = Object.values(allocation).reduce((acc, share) => acc + share, 0);
    return Math.abs(sum - ALLOCATION_SUM) <= ALLOCATION_EPSILON;
  },
  { message: "allocation percentages must sum to 100" },
);

export const DedupeExposureRowSchema = z
  .object({
    app_id: z.string(),
    targeting_key_hash: z.string(),
    environment_id: z.string(),
    id_type: z.string(),
    run_id: z.string(),
    variant: z.string(),
    first_exposure_ts: TimestampSchema,
    /** Optional ingest clock; analysis-v1/legacy ignore, analysis-v2 requires. */
    first_ingest_ts: TimestampSchema.optional(),
    window_anchor: TimestampSchema,
    dimension_values: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type DedupeExposureRow = z.infer<typeof DedupeExposureRowSchema>;

export const PerEntityMetricRowSchema = z
  .object({
    targeting_key_hash: z.string(),
    run_id: z.string(),
    metric_id: MetricIdSchema,
    metric_type: MetricKindSchema,
    value: z.number(),
    num_value: z.number().optional(),
    denom_value: z.number().optional(),
    in_window: z.boolean(),
  })
  .strict()
  .refine(
    (row) =>
      row.metric_type !== "ratio" || (row.num_value !== undefined && row.denom_value !== undefined),
    { message: "ratio metric rows require num_value and denom_value" },
  );
export type PerEntityMetricRow = z.infer<typeof PerEntityMetricRowSchema>;

export const CupedCovariateSourceSchema = z.enum([
  "pre_period",
  "declared_attribute",
  "historical_attribute",
]);
export type CupedCovariateSource = z.infer<typeof CupedCovariateSourceSchema>;

const CupedCovariateRowShape = {
  targeting_key_hash: z.string(),
  metric_id: MetricIdSchema,
  pre_period_value: z.number(),
  covariate_source: CupedCovariateSourceSchema,
  attribute: z.string().optional(),
  locked: z.boolean().optional(),
  attribute_source: CupedAttributeSourceSchema.optional(),
  observed_at: TimestampSchema.optional(),
};

export const CupedCovariateRowSchema = z.object(CupedCovariateRowShape).strict();
export type CupedCovariateRow = z.infer<typeof CupedCovariateRowSchema>;

export const PrePeriodRowSchema = z.object(CupedCovariateRowShape).strict();
export type PrePeriodRow = CupedCovariateRow;

export const ActivationRowSchema = z
  .object({
    targeting_key_hash: z.string(),
    run_id: z.string(),
    activation_ts: TimestampSchema,
    /** Optional eligibility clock; analysis-v1/legacy ignore, analysis-v2 requires. */
    activation_ingest_ts: TimestampSchema.optional(),
    counterfactual: z.boolean(),
    activated: z.boolean(),
  })
  .strict();
export type ActivationRow = z.infer<typeof ActivationRowSchema>;

export const DecisionFamilyMemberSchema = z
  .object({
    metric_id: MetricIdSchema,
    variant: z.string(),
    dimension_id: z.string().nullable().optional(),
    dimension_value: z.string().nullable().optional(),
  })
  .strict();
export type DecisionFamilyMember = z.infer<typeof DecisionFamilyMemberSchema>;

export const DimensionInputSchema = z
  .object({
    dimension_id: z.string(),
    class: DimensionClassSchema,
    values: z.array(z.string()).optional(),
  })
  .strict();
export type DimensionInput = z.infer<typeof DimensionInputSchema>;

export const GuardrailDecisionSchema = z
  .object({
    metric_id: MetricIdSchema,
    variant: z.string(),
    downside_threshold_pct: z.number(),
    guardrail_locked_at_run_start: z.boolean(),
    threshold_locked_at_run_start: z.boolean(),
  })
  .strict();
export type GuardrailDecision = z.infer<typeof GuardrailDecisionSchema>;

/**
 * Engine defaults for the variance-reduction knobs (variance-reduction.md).
 * They live on the contract rather than in the engine because Run Start resolves
 * a Metric that states no preference into an explicit frozen value, and the
 * number Start writes must be the number the engine would have used.
 */
export const DEFAULT_WINSORIZE = true;
export const DEFAULT_WINSORIZE_PCT = 99.9;
export const DEFAULT_CUPED = true;
export const DEFAULT_CUPED_COVERAGE_THRESHOLD_PCT = 70;
export const DEFAULT_CUPED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The source binding used to materialize one Metric for a Run snapshot.
 * Measurement edits can replace this payload without changing the Run id.
 */
const MetricSourceBindingSchema = z.union([
  z
    .object({
      metric_id: MetricIdSchema,
      metric_type: z.literal("binomial"),
      event_definition_id: z.string(),
      event_field_name: z.null().default(null),
    })
    .strict(),
  z
    .object({
      metric_id: MetricIdSchema,
      metric_type: z.enum(["count", "revenue"]),
      event_definition_id: z.string(),
      event_field_name: z.string(),
    })
    .strict(),
]);

const MetricQueryWindowSchema = {
  metric_id: MetricIdSchema,
  window_duration_ms: z.number().int().nonnegative(),
  window_offset_ms: z.number().int().nonnegative().optional(),
  cuped_lookback_ms: z.number().int().nonnegative(),
};

export const MetricQueryConfigSchema = z.union([
  z
    .object({
      ...MetricQueryWindowSchema,
      metric_type: z.literal("binomial"),
      event_definition_id: z.string(),
      event_field_name: z.null().default(null),
    })
    .strict(),
  z
    .object({
      ...MetricQueryWindowSchema,
      metric_type: z.literal("retention"),
      event_definition_id: z.string(),
      event_field_name: z.null().default(null),
      horizon_start_ms: z.number().int().nonnegative(),
      horizon_end_ms: z.number().int().positive(),
    })
    .strict()
    .refine((config) => config.horizon_end_ms > config.horizon_start_ms, {
      message: "horizon_end_ms must be greater than horizon_start_ms",
    }),
  z
    .object({
      ...MetricQueryWindowSchema,
      metric_type: z.enum(["count", "revenue"]),
      event_definition_id: z.string(),
      event_field_name: z.string(),
    })
    .strict(),
  z
    .object({
      ...MetricQueryWindowSchema,
      metric_type: z.literal("ratio"),
      numerator: MetricSourceBindingSchema,
      denominator: MetricSourceBindingSchema,
    })
    .strict()
    .refine((config) => config.numerator.metric_id !== config.denominator.metric_id, {
      message: "Ratio source bindings must be distinct Metrics",
    }),
]);
export type MetricQueryConfig = z.infer<typeof MetricQueryConfigSchema>;

/**
 * The variance-reduction rule frozen at Run Start for one Metric
 * (variance-reduction.md). A Metric absent from the array uses the engine
 * defaults; a Metric present states every knob, because the point of freezing is
 * that a re-analysis reproduces the original numbers without consulting the
 * Metric row, which may have been edited since.
 */
export const MetricVarianceConfigSchema = z
  .object({
    metric_id: MetricIdSchema,
    winsorize: z.boolean(),
    winsorize_pct: z.number().gt(0).max(100),
    cuped: z.boolean(),
    cuped_coverage_threshold_pct: z.number().gt(0).max(100),
  })
  .strict();
export type MetricVarianceConfig = z.infer<typeof MetricVarianceConfigSchema>;

/**
 * Frozen Conversion Window per Metric from the Run snapshot. Optional so
 * Control Plane can send it before Analysis consumes it; other StatsInput
 * readers ignore it. `window_duration_ms` of 0 is unbounded.
 */
export const MetricConversionWindowSchema = z
  .object({
    metric_id: MetricIdSchema,
    window_duration_ms: z.number().int().nonnegative(),
  })
  .strict();
export type MetricConversionWindow = z.infer<typeof MetricConversionWindowSchema>;

/**
 * Frozen Retention horizon per Metric. Optional so Control Plane can send it
 * before Analysis consumes it; other StatsInput readers ignore it.
 */
export const MetricRetentionHorizonSchema = z
  .object({
    metric_id: MetricIdSchema,
    horizon_start_ms: z.number().int().nonnegative(),
    horizon_end_ms: z.number().int().positive(),
  })
  .strict()
  .refine((horizon) => horizon.horizon_end_ms > horizon.horizon_start_ms, {
    message: "horizon_end_ms must be greater than horizon_start_ms",
  });
export type MetricRetentionHorizon = z.infer<typeof MetricRetentionHorizonSchema>;

export const StatsInputSchema = z
  .object({
    run_id: z.string(),
    /**
     * Which analysis implementation reads this evidence (ADR-0059). Callers that
     * bind a Run must pass the frozen (or legacy) version. The schema default is
     * analysis-v1 so non-Run unit fixtures keep the compatibility engine without
     * inventing a newer commitment.
     */
    analysis_version: z.string().min(1).default(ANALYSIS_V1_VERSION),
    confidence_level: z.number().default(0.95),
    horizon: z.enum(["sequential", "fixed"]).default("sequential"),
    target_n: IntegerSchema.optional(),
    sample_size_locked: IntegerSchema.optional(),
    allocation: AllocationSchema,
    control_variant: z.string(),
    decision_family: z.array(DecisionFamilyMemberSchema),
    guardrail_decisions: z.array(GuardrailDecisionSchema).default([]),
    metric_variance_config: z.array(MetricVarianceConfigSchema).default([]),
    /**
     * Frozen Conversion Window per Metric (Run snapshot / MetricQueryConfig).
     * Optional and ignored by the decision engine; cohort-effect completeness
     * filtering reads it when present.
     */
    metric_conversion_windows: z.array(MetricConversionWindowSchema).optional(),
    /**
     * Frozen Retention horizon per Metric. Optional; Analysis requires it when
     * a Retention Metric is analyzed.
     */
    metric_retention_horizons: z.array(MetricRetentionHorizonSchema).optional(),
    /**
     * Inclusive evidence watermark used to decide Retention maturity. Optional
     * so older Analysis Workers can omit it; a Retention Metric without it
     * fails in the engine rather than silently treating immature Entities as
     * failures.
     */
    data_watermark: TimestampSchema.optional(),
    /**
     * Frozen pre-registration when the Run recorded one. Drives per-Metric
     * ropeVerdict on ArmResult; omit when Start did not pre-register.
     */
    pre_registration: PreRegistrationSchema.optional(),
    exposures: z.array(DedupeExposureRowSchema),
    metric_values: z.array(PerEntityMetricRowSchema),
    pre_period_covariates: z.array(CupedCovariateRowSchema).optional(),
    activation_rows: z.array(ActivationRowSchema).optional(),
    dimensions: z.array(DimensionInputSchema).optional(),
  })
  .strict()
  .refine((input) => input.horizon !== "fixed" || input.sample_size_locked !== undefined, {
    message: "fixed horizon requires sample_size_locked",
  });
export type StatsInput = z.infer<typeof StatsInputSchema>;
