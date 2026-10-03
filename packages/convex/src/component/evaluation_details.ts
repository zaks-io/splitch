import {
  type ConvexConfigSnapshot,
  type EvaluateResult,
  type LocalResolutionDetails as ResolutionDetails,
  resolutionReasonFor,
  type VariantValue,
} from "@splitch/sdk/local-evaluation";

// Inside the sync grace the held snapshot is still the newest validated state, so its real Variant
// is served, labelled STALE because a newer version is known to exist.
export function servedDetails(
  runtime: { snapshot: ConvexConfigSnapshot; syncing: boolean },
  args: { flagKey: string; defaultValue: VariantValue },
  result: EvaluateResult,
): ResolutionDetails {
  const details = detailsFor(runtime.snapshot, args.flagKey, result, args.defaultValue);
  if (!runtime.syncing || details.reason === "ERROR") return details;
  return { value: details.value, variantName: details.variantName, reason: "STALE" };
}

export function syncOverdueDetails(
  runtime: { snapshotVersion: number; announcedVersion: number },
  defaultValue: VariantValue,
): ResolutionDetails {
  return {
    value: defaultValue,
    variantName: null,
    reason: "ERROR",
    errorCode: "PROVIDER_NOT_READY",
    errorMessage: `@splitch/convex snapshot ${runtime.snapshotVersion} is still behind announced version ${runtime.announcedVersion} past the 5-second sync deadline; check the Splitch API Key and endpoint, then run sync`,
  };
}

function detailsFor(
  snapshot: ConvexConfigSnapshot,
  flagKey: string,
  result: EvaluateResult,
  defaultValue: VariantValue,
): ResolutionDetails {
  if (result.kind === "error")
    return {
      value: defaultValue,
      variantName: null,
      reason: "ERROR",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  if (result.variant === null)
    return {
      value: defaultValue,
      variantName: null,
      reason: "ERROR",
      errorCode: "INTERNAL_SERVER_ERROR",
      errorMessage: "Evaluation returned no Variant",
    };
  const flag = snapshot.flags.find((candidate) => candidate.key === flagKey);
  const variant = flag?.variants.find((candidate) => candidate.name === result.variant);
  if (!variant)
    return {
      value: defaultValue,
      variantName: null,
      reason: "ERROR",
      errorCode: "INTERNAL_SERVER_ERROR",
      errorMessage: `Resolved Variant "${result.variant}" is absent from Flag "${flagKey}"`,
    };
  const reason = resolutionReasonFor(result.kind);
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
