import { z } from "zod";
import { CanonicalJsonSha256Schema } from "./canonical-hash";
import { MetricRefSchema } from "./leaf-schemas-experiment";
import type { StatsInput } from "./stats-input-contract";

const MetricIdSchema = MetricRefSchema.shape.metricId;
const IntegerSchema = z.number().int();
const CiBoundSchema = z
  .union([z.number(), z.literal(Number.NEGATIVE_INFINITY), z.literal(Number.POSITIVE_INFINITY)])
  .nullable();
const VariantCountSchema = z.record(z.string(), IntegerSchema);

export const statsResultStatuses = [
  "running",
  "ready",
  "stopped",
  "insufficient_denominator",
  "insufficient_n",
  "error",
] as const;

export const StatsResultStatusSchema = z.enum(statsResultStatuses);
export type StatsResultStatus = z.infer<typeof StatsResultStatusSchema>;

export const cupedMethods = ["pre_period", "attribute_covariate", "none"] as const;

export const CupedMethodSchema = z.enum(cupedMethods);
export type CupedMethod = z.infer<typeof CupedMethodSchema>;

export const cupedAttributeSources = [
  "declared",
  "pre_period_selected",
  "historical_selected",
] as const;

export const CupedAttributeSourceSchema = z.enum(cupedAttributeSources);
export type CupedAttributeSource = z.infer<typeof CupedAttributeSourceSchema>;

export const dimensionClasses = ["primary", "secondary"] as const;

export const DimensionClassSchema = z.enum(dimensionClasses);
export type DimensionClass = z.infer<typeof DimensionClassSchema>;

export const WinsorizeCapSchema = z.union([
  z.number(),
  z
    .object({
      num_value: z.number(),
      denom_value: z.number(),
    })
    .strict(),
]);
export type WinsorizeCap = z.infer<typeof WinsorizeCapSchema>;

export const VarianceTechniquesSchema = z
  .object({
    winsorized: z.boolean(),
    winsorize_pct: z.number().nullable(),
    winsorize_cap: WinsorizeCapSchema.nullable(),
    cuped_applied: z.boolean(),
    cuped_method: CupedMethodSchema.nullable(),
    cuped_attribute: z.string().nullable(),
    cuped_attribute_source: CupedAttributeSourceSchema.nullable(),
    cuped_coverage_pct: z.number().nullable(),
    delta_method: z.boolean(),
  })
  .strict();
export type VarianceTechniques = z.infer<typeof VarianceTechniquesSchema>;

export const ArmResultSchema = z
  .object({
    variant: z.string(),
    metric_id: MetricIdSchema,
    sample_size_n: IntegerSchema,
    point_estimate: z.number(),
    relative_lift_pct: z.number().nullable(),
    ci_lower: CiBoundSchema,
    ci_upper: CiBoundSchema,
    p_value: z.number(),
    is_significant: z.boolean(),
    in_bh_family: z.boolean(),
    exploratory: z.boolean(),
    decision_valid: z.boolean(),
    status: StatsResultStatusSchema,
    variance_techniques: VarianceTechniquesSchema,
  })
  .strict();
export type ArmResult = z.infer<typeof ArmResultSchema>;

export const SrmResultSchema = z
  .object({
    srm_p_value: z.number(),
    srm_is_mismatch: z.boolean(),
    observed_counts: VariantCountSchema,
    expected_counts: VariantCountSchema,
    activated_srm_p_value: z.number().nullable(),
    activated_srm_mismatch: z.boolean().nullable(),
  })
  .strict();
export type SrmResult = z.infer<typeof SrmResultSchema>;

export const GuardrailResultSchema = z
  .object({
    metric_id: MetricIdSchema,
    variant: z.string(),
    ci_lower: CiBoundSchema,
    threshold: z.number(),
    is_breached: z.boolean().nullable(),
    in_bh_family: z.boolean(),
    exploratory: z.boolean(),
    decision_valid: z.boolean(),
    breach_reason: z.string().nullable(),
  })
  .strict();
export type GuardrailResult = z.infer<typeof GuardrailResultSchema>;

export const HealthMetricsSchema = z
  .object({
    multiple_rate: z.number(),
    multiple_count: IntegerSchema,
    activation_rates: z.record(z.string(), z.number()).nullable(),
    activation_balance_p_value: z.number().nullable(),
    activation_balance_mismatch: z.boolean().nullable(),
    exposure_counts: VariantCountSchema,
    deduped_counts: VariantCountSchema,
    low_n_warning: z.boolean(),
  })
  .strict();
export type HealthMetrics = z.infer<typeof HealthMetricsSchema>;

export const DimensionResultSchema = z
  .object({
    dimension_id: z.string(),
    dimension_value: z.string(),
    class: DimensionClassSchema,
    arm_results: z.array(ArmResultSchema),
    sample_size_n: IntegerSchema,
    low_n_warning: z.boolean(),
    in_bh_family: z.boolean(),
    exploratory: z.boolean(),
    decision_valid: z.boolean(),
  })
  .strict();
export type DimensionResult = z.infer<typeof DimensionResultSchema>;

export const StatsOutputSchema = z
  .object({
    arm_results: z.array(ArmResultSchema),
    srm: SrmResultSchema,
    guardrail_results: z.array(GuardrailResultSchema),
    health: HealthMetricsSchema,
    dimension_results: z.array(DimensionResultSchema).optional(),
  })
  .strict();
export type StatsOutput = z.infer<typeof StatsOutputSchema>;

/**
 * What a locked Run is still waiting on before StatsEngine can run.
 *
 * Same early-Run concept as `app-attention-rollup`'s `state: "no_data"` (SPL-290):
 * Exposures without Metric Events (or vice versa) is a healthy collecting state,
 * not a request validation failure and not an Analysis outage (SPL-302).
 */
const AnalysisResultsMissingInputSchema = z.enum(["exposures", "metric_events"]);

/**
 * What the Analysis Worker answers a /results read with.
 *
 * `state` mirrors the attention-rollup discriminator: `no_data` keeps "nothing
 * measurable yet" distinct from a measured `ready` result. Naming `missing`
 * tells the caller which input is still empty without turning that into a 4xx.
 *
 * `no_run` is a separate member (SPL-305), not a `missing` value on `no_data`:
 * a draft Experiment has no Run at all, so `run_id` / `control_variant` cannot
 * be populated without fabricating a placeholder. `recommended_action` names
 * Start (`START_A_RUN`) as the step that produces results. `EXPERIMENT_NOT_FOUND`
 * is reserved for a missing or out-of-scope Experiment id.
 *
 * `run_id` is provenance and is checked: a read whose answer names a different
 * Run than the one asked for is refused rather than relabelled (ADR-0006).
 *
 * `control_variant` is not. It reaches this Worker from the `analysis_run_inputs`
 * pipe, which resolves it at read time, so it describes current configuration.
 * A caller that needs the Run's actual baseline resolves it from the immutable
 * `runs.control_variant_id` inside that Run's own frozen Variant set instead
 * (`resolveFrozenControlIdentity`, ADR-0002, ADR-0003), which is what the
 * Control Panel Results read does.
 */
export const AnalysisResultsEnvelopeSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      run_id: z.string().min(1),
      control_variant: z.string().min(1),
      data_watermark: z.string().datetime({ offset: true }).optional(),
      result_token: CanonicalJsonSha256Schema.optional(),
      stats: StatsOutputSchema,
    })
    .strict()
    .superRefine((result, context) => {
      if ((result.data_watermark === undefined) === (result.result_token === undefined)) return;
      context.addIssue({
        code: "custom",
        message: "data_watermark and result_token must be present together",
      });
    }),
  z
    .object({
      state: z.literal("no_data"),
      run_id: z.string().min(1),
      control_variant: z.string().min(1),
      missing: AnalysisResultsMissingInputSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("no_run"),
      recommended_action: z.literal("START_A_RUN"),
    })
    .strict(),
]);
export type AnalysisResultsEnvelope = z.infer<typeof AnalysisResultsEnvelopeSchema>;

export interface StatsEngine {
  analyze(input: StatsInput): Promise<StatsOutput>;
}
