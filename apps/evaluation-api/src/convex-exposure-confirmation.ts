import type { ConvexServerExposureItem, ConvexServerExposureResponse } from "@splitch/contracts";
import type { EvaluatePathDeps } from "@splitch/evaluation-core";
import { errorCauseChain } from "./error-cause-chain";
import type {
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";

interface ConvexExposureConfirmationDeps extends Pick<EvaluatePathDeps, "logger"> {
  exposureRedemptionClaims: ExposureRedemptionClaimStore;
}

export async function confirmConvexExposureClaim(
  claimInput: ExposureRedemptionClaimInput,
  item: ConvexServerExposureItem,
  deps: ConvexExposureConfirmationDeps,
): Promise<ConvexServerExposureResponse["results"][number] | null> {
  try {
    await deps.exposureRedemptionClaims.markSealed(claimInput);
    await deps.exposureRedemptionClaims.acknowledge(claimInput);
    return null;
  } catch (cause) {
    // Event Ingest already committed. Keep the claim so an exact retry resumes
    // acknowledgment instead of appending the Exposure a second time.
    deps.logger?.error("convex_exposure_confirm_failed", {
      exposureId: item.exposureId,
      cause: errorCauseChain(cause),
    });
    return {
      exposureId: item.exposureId,
      status: "rejected",
      code: "SERVICE_UNAVAILABLE",
      message: "SERVICE_UNAVAILABLE",
      retryable: true,
    };
  }
}
