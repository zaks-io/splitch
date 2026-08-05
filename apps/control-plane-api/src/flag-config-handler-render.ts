import type { ApprovalRequest } from "@splitch/contracts";
import type { ConfigStoreWriter } from "./config-store";
import { variantNotAvailable } from "./experiment-errors";
import { flagConfigNotFound, rolloutAmbiguous } from "./flag-config-errors";
import { runFrozenResponse } from "./flag-config-run-freeze";

/**
 * Request shaping and refusal rendering for the Flag Configuration routes.
 *
 * The routes themselves decide Policy and ordering; everything here is the
 * translation between the ConfigStore's typed result union and the wire. Each
 * refusal reason gets its own arm so a new one fails to compile rather than
 * falling through to `FLAG_NOT_FOUND`, which would report the wrong decision.
 */

type FlagConfigWriteResult = Awaited<ReturnType<ConfigStoreWriter["writeFlagConfig"]>>;
type PromotionResult = Awaited<ReturnType<ConfigStoreWriter["promoteFlagConfig"]>>;
export type PromotionSelect = Parameters<ConfigStoreWriter["promoteFlagConfig"]>[0]["select"];

export function flagConfigPatchInput(
  appId: string,
  environmentId: string,
  flagId: string,
  payload: Record<string, unknown>,
): Parameters<ConfigStoreWriter["writeFlagConfig"]>[0] {
  return {
    appId,
    environmentId,
    flagId,
    ...(payload.enabled !== undefined ? { enabled: payload.enabled as boolean } : {}),
    ...(payload.availableVariantNames !== undefined
      ? { availableVariantNames: payload.availableVariantNames as string[] }
      : {}),
    ...(payload.rollout !== undefined
      ? { rollout: payload.rollout as { percentage: number } | null }
      : {}),
  };
}

export function flagConfigProposalInput(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    ...(payload.availableVariantNames !== undefined
      ? { availableVariantNames: payload.availableVariantNames }
      : {}),
    ...(payload.rollout !== undefined ? { rollout: payload.rollout } : {}),
  };
}

export function renderFlagConfigWriteResult(
  result: FlagConfigWriteResult,
  flagId: string,
  environmentId: string,
  requestId: string,
  approvalRequest: ApprovalRequest | null,
): Response {
  if (result.ok) return Response.json({ config: result.config, approvalRequest });
  if (result.reason === "VARIANT_NOT_AVAILABLE") {
    return variantNotAvailable(flagId, environmentId, result.missingVariants, requestId);
  }
  if (result.reason === "ROLLOUT_AMBIGUOUS") {
    return rolloutAmbiguous(result.availableVariantNames, requestId);
  }
  if (result.reason === "RUN_FROZEN") return runFrozenResponse(result, requestId);
  // Direct writers never produce APPROVAL_NOT_APPLIED or CHANGED_FIELDS_UNDETERMINED.
  return flagConfigNotFound(requestId);
}

export function renderPromotionResult(
  result: PromotionResult,
  flagId: string,
  environmentId: string,
  requestId: string,
  approvalRequest: ApprovalRequest | null,
): Response {
  if (result.ok) {
    return Response.json({ config: result.config, diff: result.diff, approvalRequest });
  }
  if (result.reason === "VARIANT_NOT_AVAILABLE") {
    return variantNotAvailable(flagId, environmentId, result.missingVariants, requestId);
  }
  if (result.reason === "ROLLOUT_AMBIGUOUS") {
    return rolloutAmbiguous(result.availableVariantNames, requestId);
  }
  if (result.reason === "RUN_FROZEN") return runFrozenResponse(result, requestId);
  // Direct writers never produce APPROVAL_NOT_APPLIED or CHANGED_FIELDS_UNDETERMINED.
  return flagConfigNotFound(requestId);
}
