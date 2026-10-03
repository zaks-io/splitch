import { z } from "zod";
import { CanonicalJsonSha256Schema } from "./canonical-hash";
import { CohortEffectDiagnosticSchema } from "./cohort-effect";
import { MetricRefSchema } from "./leaf-schemas-experiment";
import { RunCommitmentsSchema } from "./run-commitments";
import type { StatsInput } from "./stats-input-contract";
import { ArmResultSchema, CiBoundSchema } from "./stats-result-arm";

// Re-exports live in barrels/stats-contracts.ts so this file is not a barrel.

const MetricIdSchema = MetricRefSchema.shape.metricId;
const IntegerSchema = z.number().int();
const VariantCountSchema = z.record(z.string(), IntegerSchema);

export const dimensionClasses = ["primary", "secondary"] as const;
export const DimensionClassSchema = z.enum(dimensionClasses);
export type DimensionClass = z.infer<typeof DimensionClassSchema>;

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
export const AnalysisResultsMissingInputSchema = z.enum(["exposures", "metric_events"]);
export type AnalysisResultsMissingInput = z.infer<typeof AnalysisResultsMissingInputSchema>;

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
 * `control_variant` reaches this Worker from the `analysis_run_inputs` pipe,
 * which reads the Run Snapshot written at Start. It is frozen Analysis input,
 * not current Experiment configuration. The Control Panel Results read resolves
 * the displayed Control identity from immutable `runs.control_variant_id`
 * inside that Run's own frozen Variant set, then blocks the decision when that
 * D1 identity and the Analysis Run Snapshot disagree
 * (`resolveAnalysisControlIntegrity`, ADR-0002, ADR-0003, ADR-0047).
 */
export const AnalysisResultsEnvelopeSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      run_id: z.string().min(1),
      control_variant: z.string().min(1),
      data_watermark: z.string().datetime({ offset: true }).optional(),
      result_token: CanonicalJsonSha256Schema.optional(),
      /**
       * What the Run froze at Start: analysis version, target_n and whether it
       * was defaulted, planned duration (ADR-0059). Optional only so a Control
       * Plane reading an Analysis Worker from before this field still parses.
       */
      run_commitments: RunCommitmentsSchema.optional(),
      /**
       * First-exposure-day cohort-effect diagnostic (plan 2.8). Optional so
       * Control Plane can deploy before Analysis emits it; never hashed into
       * result_token.
       */
      cohort_effect: CohortEffectDiagnosticSchema.optional(),
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
