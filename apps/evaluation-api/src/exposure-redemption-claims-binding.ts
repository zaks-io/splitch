import type { EvaluationApiEnv } from "./env";

/**
 * Startup fail-loud for the SPL-345 claim DO binding. Called from the Worker
 * request path when constructing DurableExposureRedemptionClaimStore.
 */
export function requiredExposureRedemptionClaimsBinding(
  binding: EvaluationApiEnv["EXPOSURE_REDEMPTION_CLAIMS"],
): NonNullable<EvaluationApiEnv["EXPOSURE_REDEMPTION_CLAIMS"]> {
  if (!binding) throw new Error("evaluation-api: EXPOSURE_REDEMPTION_CLAIMS is required");
  return binding;
}
