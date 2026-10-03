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
] as const;
export const RecommendationUnavailableReasonSchema = z.enum(recommendationUnavailableReasons);
export type RecommendationUnavailableReason = z.infer<typeof RecommendationUnavailableReasonSchema>;
