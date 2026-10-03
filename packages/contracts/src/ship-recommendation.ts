import { z } from "zod";

/**
 * Ship recommendation from the locked ship rule and decision gate (plan 2.4).
 *
 * Present only when the Run froze a pre-registration. Otherwise the producer
 * omits `recommendation` and sets `recommendationUnavailable`.
 */

export const shipRecommendationVerdicts = [
  "ship",
  "do_not_ship",
  "keep_running",
  "invalid",
] as const;
export const ShipRecommendationVerdictSchema = z.enum(shipRecommendationVerdicts);
export type ShipRecommendationVerdict = z.infer<typeof ShipRecommendationVerdictSchema>;

export const ShipRecommendationSchema = z
  .object({
    verdict: ShipRecommendationVerdictSchema,
    /** One sentence naming the deciding fact with numbers; no internal ids. */
    because: z.string().min(1),
  })
  .strict();
export type ShipRecommendation = z.infer<typeof ShipRecommendationSchema>;

export const recommendationUnavailableReasons = [
  "no_pre_registration",
  "absolute_interval_unavailable",
  "primary_result_unavailable",
  /**
   * Relative ship-rule margins use Fieller intervals; sequential Fieller
   * time-uniform coverage is unproven (result-contracts.md). Refused at Start
   * with PREREG_SHIP_RULE_RELATIVE_SEQUENTIAL_UNSUPPORTED; fail-loud here if a
   * sequential Run somehow carries a relative ship rule.
   */
  "relative_sequential_coverage_unproven",
] as const;
export const RecommendationUnavailableReasonSchema = z.enum(recommendationUnavailableReasons);
export type RecommendationUnavailableReason = z.infer<typeof RecommendationUnavailableReasonSchema>;
