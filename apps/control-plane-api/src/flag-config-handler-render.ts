import type { ApprovalRequest } from "@splitch/contracts";
import type { Principal } from "@splitch/worker-runtime";
import type { ConfigStoreWriter } from "./config-store";
import type { FlagConfigActor } from "./config-store-types";
import { variantNotAvailable } from "./experiment-errors";
import {
  flagConfigNotFound,
  flagSegmentNotFound,
  rolloutAmbiguous,
  targetingRuleIdConflict,
} from "./flag-config-errors";
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

/**
 * The resolved caller, in the shape the Flag Configuration write path stamps
 * onto `flag_configs` for the audit triggers. `principal.id` is already the
 * opaque credential/user identifier the guard resolved, so nothing here reaches
 * for a name or an email (ADR-0032).
 */
export function actorOf(principal: Principal): FlagConfigActor {
  return { ref: principal.id, via: principal.kind };
}

export function renderFlagConfigReadFailure(
  result: Extract<Awaited<ReturnType<ConfigStoreWriter["readFlagConfig"]>>, { ok: false }>,
  requestId: string,
): Response {
  return result.reason === "SEGMENT_NOT_FOUND"
    ? flagSegmentNotFound(result.missingSegmentIds, requestId)
    : flagConfigNotFound(requestId);
}

export function flagConfigPatchInput(
  appId: string,
  environmentId: string,
  flagId: string,
  payload: Record<string, unknown>,
  actor: FlagConfigActor,
): Parameters<ConfigStoreWriter["writeFlagConfig"]>[0] {
  return {
    actor,
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
  if (result.ok) return Response.json({ ...result.config, approvalRequest });
  if (result.reason === "VARIANT_NOT_AVAILABLE") {
    return variantNotAvailable(flagId, environmentId, result.missingVariants, requestId);
  }
  if (result.reason === "ROLLOUT_AMBIGUOUS") {
    return rolloutAmbiguous(result.availableVariantNames, requestId);
  }
  if (result.reason === "SEGMENT_NOT_FOUND") {
    return flagSegmentNotFound(result.missingSegmentIds, requestId);
  }
  if (result.reason === "TARGETING_RULE_ID_CONFLICT") {
    return targetingRuleIdConflict(result.targetingRules, requestId);
  }
  if (result.reason === "RUN_FROZEN") return runFrozenResponse(result, requestId);
  // Direct writers never produce APPROVAL_NOT_APPLIED, CHANGED_FIELDS_UNDETERMINED,
  // or APPROVAL_EMPTY_CHANGE.
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
    return Response.json({ ...result.config, diff: result.diff, approvalRequest });
  }
  if (result.reason === "VARIANT_NOT_AVAILABLE") {
    return variantNotAvailable(flagId, environmentId, result.missingVariants, requestId);
  }
  if (result.reason === "ROLLOUT_AMBIGUOUS") {
    return rolloutAmbiguous(result.availableVariantNames, requestId);
  }
  if (result.reason === "SEGMENT_NOT_FOUND") {
    return flagSegmentNotFound(result.missingSegmentIds, requestId);
  }
  if (result.reason === "TARGETING_RULE_ID_CONFLICT") {
    return targetingRuleIdConflict(result.targetingRules, requestId);
  }
  if (result.reason === "RUN_FROZEN") return runFrozenResponse(result, requestId);
  // Direct writers never produce APPROVAL_NOT_APPLIED, CHANGED_FIELDS_UNDETERMINED,
  // or APPROVAL_EMPTY_CHANGE.
  return flagConfigNotFound(requestId);
}
