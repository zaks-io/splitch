import { z } from "zod";
import { MetricKindSchema, MetricRefSchema } from "./leaf-schemas-experiment.js";
import { CupedAttributeSourceSchema, DimensionClassSchema } from "./stats-result-contract.js";

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

const GuardrailDecisionSchema = z
  .object({
    metric_id: MetricIdSchema,
    variant: z.string(),
    downside_threshold: z.number(),
    guardrail_locked_at_run_start: z.boolean(),
    threshold_locked_at_run_start: z.boolean(),
  })
  .strict();

export const StatsInputSchema = z
  .object({
    run_id: z.string(),
    confidence_level: z.number().default(0.95),
    horizon: z.enum(["sequential", "fixed"]).default("sequential"),
    target_n: IntegerSchema.optional(),
    sample_size_locked: IntegerSchema.optional(),
    allocation: AllocationSchema,
    control_variant: z.string(),
    decision_family: z.array(DecisionFamilyMemberSchema),
    guardrail_decisions: z.array(GuardrailDecisionSchema).default([]),
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
