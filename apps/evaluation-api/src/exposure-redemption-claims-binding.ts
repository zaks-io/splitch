import type { EvaluationApiEnv } from "./env";

/**
 * Per-request fail-loud for the SPL-345 claim DO binding. Called from the
 * Worker request path (every non-health request) when constructing
 * DurableExposureRedemptionClaimStore — not at module load / Worker startup.
 * `/health` does not exercise this check.
 */
export function requiredExposureRedemptionClaimsBinding(
  binding: EvaluationApiEnv["EXPOSURE_REDEMPTION_CLAIMS"],
): NonNullable<EvaluationApiEnv["EXPOSURE_REDEMPTION_CLAIMS"]> {
  if (!binding) throw new Error("evaluation-api: EXPOSURE_REDEMPTION_CLAIMS is required");
  return binding;
}
