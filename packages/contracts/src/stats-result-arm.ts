import { z } from "zod";
import { MetricRefSchema } from "./leaf-schemas-experiment";
import { RopeScaleSchema } from "./run-preregistration";

/**
 * Per-arm Stats result schemas (and the disclosure / variance shapes they nest).
 * Kept beside ArmResult so absolute CI for the ship recommendation (plan 2.4)
 * does not grow stats-result-contract.ts past the file-size ratchet.
 */

const MetricIdSchema = MetricRefSchema.shape.metricId;
const IntegerSchema = z.number().int();
export const CiBoundSchema = z
  .union([z.number(), z.literal(Number.NEGATIVE_INFINITY), z.literal(Number.POSITIVE_INFINITY)])
  .nullable();

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

export const estimandLabels = [
  "uncapped_additive_mean",
  "capped_additive_mean",
  "binomial_mean",
  "ratio_of_uncapped_means",
  "ratio_of_capped_means",
] as const;
export const EstimandLabelSchema = z.enum(estimandLabels);
export type EstimandLabel = z.infer<typeof EstimandLabelSchema>;

export const UncappedEstimateSchema = z
  .object({
    label: EstimandLabelSchema,
    point_estimate: z.number(),
    relative_lift_pct: z.number().nullable(),
    ci_lower: CiBoundSchema,
    ci_upper: CiBoundSchema,
    p_value: z.number(),
    status: StatsResultStatusSchema,
    cuped_applied: z.boolean(),
  })
  .strict();
export type UncappedEstimate = z.infer<typeof UncappedEstimateSchema>;

export const EstimandDisclosureSchema = z
  .object({
    label: EstimandLabelSchema,
    decision_label: EstimandLabelSchema,
    capped_entity_count: IntegerSchema.nullable(),
    uncapped: UncappedEstimateSchema.nullable(),
  })
  .strict()
  .superRefine((estimand, context) => {
    if ((estimand.capped_entity_count === null) === (estimand.uncapped === null)) return;
    context.addIssue({
      code: "custom",
      message: "capped_entity_count and uncapped must be present together",
    });
  });
export type EstimandDisclosure = z.infer<typeof EstimandDisclosureSchema>;

export const RopeVerdictSchema = z.enum(["outside", "inside", "undecided"]);
export type RopeVerdict = z.infer<typeof RopeVerdictSchema>;

export const RopeVerdictUnavailableReasonSchema = z.enum(["relative_sequential_coverage_unproven"]);
export type RopeVerdictUnavailableReason = z.infer<typeof RopeVerdictUnavailableReasonSchema>;

/** Advisory MDE-exclusion futility (plan 2.12); never stops or Concludes a Run. */
export const FutilityVerdictSchema = z.enum(["futile", "not_futile"]);
export type FutilityVerdict = z.infer<typeof FutilityVerdictSchema>;

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
    // Optional only so Stats recorded before the disclosure existed still
    // parse; the engine always emits it.
    estimand: EstimandDisclosureSchema.optional(),
    /**
     * Present only when this Metric pre-registered an absolute ROPE and the
     * decision interval is finite. Absent (not defaulted) otherwise.
     */
    ropeVerdict: RopeVerdictSchema.optional(),
    /** Scale the ROPE and decision interval shared when ropeVerdict is present. */
    ropeScale: RopeScaleSchema.optional(),
    /**
     * Present when a ROPE was pre-registered but no always-valid verdict can be
     * claimed (relative scale under sequential analysis). Exclusive with
     * ropeVerdict; never a silent omission of a pre-registered ROPE.
     */
    ropeVerdictUnavailable: RopeVerdictUnavailableReasonSchema.optional(),
    /**
     * Present only for the primary Metric when pre-registration froze
     * `futility: "mde_exclusion"`, an absolute MDE, and a finite absolute
     * decision interval. Absent (not defaulted) when futility is off or no MDE.
     */
    futilityVerdict: FutilityVerdictSchema.optional(),
    /** One-sentence reason; required together with futilityVerdict. */
    futilityBecause: z.string().min(1).optional(),
    /**
     * Absolute decision-interval bounds. Optional for arms recorded before
     * plan 2.4. Present together when the absolute interval is finite; stripped
     * from the result token so existing Runs keep byte-identical tokens.
     */
    absolute_ci_lower: CiBoundSchema.optional(),
    absolute_ci_upper: CiBoundSchema.optional(),
    /**
     * Bonferroni simultaneous absolute interval at alpha/k for ship-rule margin
     * clearance when the freeze can ship on any of k > 1 Metric×Treatment
     * comparisons. Recomputed from the same CI adapter (not a rescaled ordinary
     * interval). Stripped from the result token. Present together when finite.
     */
    simultaneous_absolute_ci_lower: CiBoundSchema.optional(),
    simultaneous_absolute_ci_upper: CiBoundSchema.optional(),
    /**
     * Fieller relative (percent) bounds derived from the alpha/k absolute
     * interval when the ship rule is relative. Present together when finite.
     */
    simultaneous_ci_lower: CiBoundSchema.optional(),
    simultaneous_ci_upper: CiBoundSchema.optional(),
  })
  .strict()
  .superRefine((arm, context) => {
    if (arm.ropeVerdict !== undefined && arm.ropeVerdictUnavailable !== undefined) {
      context.addIssue({
        code: "custom",
        message: "ropeVerdict and ropeVerdictUnavailable are mutually exclusive",
      });
    }
    if (arm.ropeVerdict !== undefined && arm.ropeScale === undefined) {
      context.addIssue({
        code: "custom",
        message: "ropeScale is required when ropeVerdict is present",
      });
    }
    if (arm.ropeVerdict === undefined && arm.ropeScale !== undefined) {
      context.addIssue({
        code: "custom",
        message: "ropeScale requires ropeVerdict",
      });
    }
    if ((arm.futilityVerdict === undefined) !== (arm.futilityBecause === undefined)) {
      context.addIssue({
        code: "custom",
        message: "futilityVerdict and futilityBecause must be present together",
      });
    }
    if ((arm.absolute_ci_lower === undefined) !== (arm.absolute_ci_upper === undefined)) {
      context.addIssue({
        code: "custom",
        message: "absolute_ci_lower and absolute_ci_upper must be present together",
      });
    }
    if (
      (arm.simultaneous_absolute_ci_lower === undefined) !==
      (arm.simultaneous_absolute_ci_upper === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "simultaneous_absolute_ci_lower and simultaneous_absolute_ci_upper must be present together",
      });
    }
    if ((arm.simultaneous_ci_lower === undefined) !== (arm.simultaneous_ci_upper === undefined)) {
      context.addIssue({
        code: "custom",
        message: "simultaneous_ci_lower and simultaneous_ci_upper must be present together",
      });
    }
  });
export type ArmResult = z.infer<typeof ArmResultSchema>;
