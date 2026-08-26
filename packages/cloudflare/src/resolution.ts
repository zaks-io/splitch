import type { CloudflareConfigSnapshot, VariantValue } from "@splitch/contracts";
import type { EvaluateResult } from "@splitch/evaluation-core";
import type { CloudflareResolutionDetails } from "./public-types";

export function detailsFor(
  snapshot: CloudflareConfigSnapshot,
  flagKey: string,
  result: EvaluateResult,
  defaultValue: VariantValue,
): CloudflareResolutionDetails {
  if (result.kind === "error")
    return {
      value: defaultValue,
      variantName: null,
      reason: result.reason,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  if (result.variant === null) return internalError(defaultValue, "Evaluation returned no Variant");
  const flag = snapshot.flags.find((candidate) => candidate.key === flagKey);
  const variant = flag?.variants.find((candidate) => candidate.name === result.variant);
  if (!variant)
    return internalError(
      defaultValue,
      `Resolved Variant "${result.variant}" is absent from Flag "${flagKey}"`,
    );
  const reason = resolutionReason(result.kind);
  return {
    value: variant.value,
    variantName: variant.name,
    reason,
    ...(reason === "TARGETING_MATCH" &&
    typeof result.reason === "object" &&
    result.reason.type === "rule_matched"
      ? { ruleId: result.reason.ruleId }
      : {}),
  };
}

export function failureDetails(
  defaultValue: VariantValue,
  reason: "ERROR" | "STALE",
  errorCode: "PROVIDER_NOT_READY" | "INTERNAL_SERVER_ERROR",
  errorMessage: string,
): CloudflareResolutionDetails {
  return { value: defaultValue, variantName: null, reason, errorCode, errorMessage };
}

function internalError(
  defaultValue: VariantValue,
  errorMessage: string,
): CloudflareResolutionDetails {
  return failureDetails(defaultValue, "ERROR", "INTERNAL_SERVER_ERROR", errorMessage);
}

function resolutionReason(kind: EvaluateResult["kind"]): CloudflareResolutionDetails["reason"] {
  if (kind === "disabled") return "DISABLED";
  if (kind === "rule_match_direct" || kind === "rule_match_percentage") return "TARGETING_MATCH";
  if (kind === "holdover_replay") return "CACHED";
  if (kind === "no_match_default" || kind === "no_live_run" || kind === "null_experiment")
    return "DEFAULT";
  return "SPLIT";
}
