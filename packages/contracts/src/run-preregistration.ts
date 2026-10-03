import { z } from "zod";
import { MetricDirectionSchema, MetricRefSchema } from "./leaf-schemas-experiment";

/**
 * Pre-registration frozen at Run Start (plan 2.2): hypothesis, primary Metric,
 * per-Metric desirability / optional MDE / optional ROPE, a locked ship rule,
 * and an opt-in futility mode (plan 2.12).
 *
 * Optional on Start: omitting it leaves existing clients unchanged. Once frozen
 * it is immutable. The ship recommendation (plan 2.4) and futility verdict
 * (plan 2.12) read this object from `run_commitments.pre_registration`.
 */

const MetricIdSchema = MetricRefSchema.shape.metricId;

/** How conflicting goal Metrics resolve when the ship recommendation lands (2.4). */
export const shipConflictResolutions = ["primary_wins", "unanimous_goals", "any_goal"] as const;
export const ShipConflictResolutionSchema = z.enum(shipConflictResolutions);
export type ShipConflictResolution = z.infer<typeof ShipConflictResolutionSchema>;

/**
 * Advisory MDE-exclusion futility (plan 2.12). Default `off`; never stops or
 * Concludes a Run. `mde_exclusion` requires an absolute MDE on the primary Metric.
 */
export const futilityModes = ["off", "mde_exclusion"] as const;
export const FutilityModeSchema = z.enum(futilityModes);
export type FutilityMode = z.infer<typeof FutilityModeSchema>;

export const RopeScaleSchema = z.enum(["absolute", "relative"]);
export type RopeScale = z.infer<typeof RopeScaleSchema>;

/**
 * Frozen ROPE. Start accepts only `scale: "absolute"` (proven confidence
 * sequence); relative is refused with `PREREG_ROPE_RELATIVE_UNSUPPORTED`.
 * The schema still admits `"relative"` so a corrupted or legacy freeze can be
 * parsed and surface `ropeVerdictUnavailable` at results time.
 */
export const PreRegistrationRopeSchema = z
  .object({
    lower: z.number().finite(),
    upper: z.number().finite(),
    scale: RopeScaleSchema,
  })
  .strict();
export type PreRegistrationRope = z.infer<typeof PreRegistrationRopeSchema>;

export const PreRegistrationMetricSchema = z
  .object({
    metric_id: MetricIdSchema,
    desirability: MetricDirectionSchema,
    /** Absolute MDE on the decision-interval scale; omit when unused. */
    mde_absolute: z.number().finite().positive().optional(),
    /** Relative MDE (fraction of Control); omit when unused. */
    mde_relative: z.number().finite().positive().optional(),
    rope: PreRegistrationRopeSchema.optional(),
  })
  .strict();
export type PreRegistrationMetric = z.infer<typeof PreRegistrationMetricSchema>;

/**
 * Locked ship rule. `required_margin` is the minimum effect that counts as a
 * win on `margin_scale`. `conflict_resolution` says how goal Metrics combine
 * when 2.4 computes a recommendation; this slice only freezes the rule.
 */
export const ShipRuleSchema = z
  .object({
    required_margin: z.number().finite().positive(),
    margin_scale: RopeScaleSchema,
    conflict_resolution: ShipConflictResolutionSchema,
  })
  .strict();
export type ShipRule = z.infer<typeof ShipRuleSchema>;

/** Frozen form (snake_case), stored on the Run and returned in run_commitments. */
export const PreRegistrationSchema = z
  .object({
    hypothesis: z.string().min(1),
    primary_metric_id: MetricIdSchema,
    metrics: z.array(PreRegistrationMetricSchema).min(1),
    ship_rule: ShipRuleSchema,
    /**
     * Always written at freeze. `.default("off")` keeps Runs frozen before
     * plan 2.12 parseable without inventing a different mode.
     */
    futility: FutilityModeSchema.default("off"),
  })
  .strict();
export type PreRegistration = z.infer<typeof PreRegistrationSchema>;

/**
 * Start-body form (camelCase), matching targetN / plannedDurationDays.
 *
 * Hypothesis emptiness and ship-rule margin positivity are enforced in
 * `resolvePreRegistration` (stable PREREG_* codes). Keeping those checks out of
 * the Zod shape lets the request boundary surface the same codes instead of a
 * generic schema message before resolve runs.
 */
export const PreRegistrationIntentSchema = z
  .object({
    hypothesis: z.string(),
    primaryMetricId: MetricIdSchema,
    metrics: z
      .array(
        z
          .object({
            metricId: MetricIdSchema,
            desirability: MetricDirectionSchema.optional(),
            mdeAbsolute: z.number().finite().positive().optional(),
            mdeRelative: z.number().finite().positive().optional(),
            rope: z
              .object({
                lower: z.number().finite(),
                upper: z.number().finite(),
                scale: RopeScaleSchema,
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1),
    shipRule: z
      .object({
        requiredMargin: z.number().finite(),
        marginScale: RopeScaleSchema,
        conflictResolution: ShipConflictResolutionSchema,
      })
      .strict(),
    /** Omit to freeze as `off`. */
    futility: FutilityModeSchema.optional(),
  })
  .strict();
export type PreRegistrationIntent = z.infer<typeof PreRegistrationIntentSchema>;

/** Stable codes on VALIDATION_ERROR issues for pre-registration failures. */
export const preRegistrationIssueCodes = [
  "PREREG_UNKNOWN_PRIMARY_METRIC",
  "PREREG_UNKNOWN_METRIC",
  "PREREG_ROPE_BOUNDS_INVALID",
  /**
   * Relative ROPE is refused at Start: sequential Fieller relative intervals do
   * not yet have proven time-uniform coverage, so a ROPE verdict would not be
   * an always-valid confidence-sequence claim. Pre-register on `absolute`.
   */
  "PREREG_ROPE_RELATIVE_UNSUPPORTED",
  /**
   * `futility: "mde_exclusion"` needs an absolute MDE on the primary Metric.
   * Relative MDE alone is refused: sequential Fieller coverage is unproven
   * (same bar as relative ROPE; see result-contracts.md).
   */
  "PREREG_FUTILITY_REQUIRES_ABSOLUTE_MDE",
  /**
   * Relative ship-rule margins use Fieller intervals; sequential Fieller
   * time-uniform coverage is unproven (result-contracts.md). Use absolute
   * margin_scale on a sequential Run, or set horizon to fixed.
   */
  "PREREG_SHIP_RULE_RELATIVE_SEQUENTIAL_UNSUPPORTED",
  "PREREG_DESIRABILITY_REQUIRED",
  "PREREG_PRIMARY_METRIC_MISSING",
  "PREREG_DUPLICATE_METRIC",
  "PREREG_SHIP_RULE_INVALID",
  "PREREG_HYPOTHESIS_REQUIRED",
  "PREREG_MALFORMED",
] as const;
export type PreRegistrationIssueCode = (typeof preRegistrationIssueCodes)[number];
