import { formatSdkErrorMessage } from "../errors";
import type { Logger } from "../evaluate";
import type { EvaluateAllEntry, VariantValue } from "../generated/contract-surface.js";
import type { SdkResolutionDetails } from "../resolution";

export type HeldResolution =
  | { readonly kind: "missing"; readonly details: SdkResolutionDetails }
  | { readonly kind: "error"; readonly details: SdkResolutionDetails }
  | { readonly kind: "null-variant"; readonly details: SdkResolutionDetails }
  | { readonly kind: "entry"; readonly details: SdkResolutionDetails };

export function deriveHeldResolution(
  flagKey: string,
  entry: EvaluateAllEntry | undefined,
  defaultValue: VariantValue,
): HeldResolution {
  if (entry === undefined) {
    return {
      kind: "missing",
      details: {
        value: defaultValue,
        variantName: null,
        reason: "ERROR",
        errorCode: "FLAG_NOT_FOUND",
        errorMessage: `Flag key ${JSON.stringify(flagKey)} is absent from the held Precomputed Evaluations`,
      },
    };
  }
  if (entry.reason === "ERROR") {
    return {
      kind: "error",
      details: {
        value: defaultValue,
        variantName: null,
        reason: "ERROR",
        errorCode: entry.errorCode ?? "INTERNAL_SERVER_ERROR",
        errorMessage: `Held evaluation for ${JSON.stringify(flagKey)} carries reason ERROR`,
      },
    };
  }
  if (entry.variant === null) {
    return {
      kind: "null-variant",
      details: { value: defaultValue, variantName: null, reason: "DEFAULT" },
    };
  }
  return {
    kind: "entry",
    details: { value: entry.variant, variantName: entry.variantName, reason: entry.reason },
  };
}

export function logHeldResolution(
  flagKey: string,
  resolution: HeldResolution,
  targetingKey: string,
  logger: Logger,
  loggedResolutions: Set<string>,
): void {
  if (resolution.kind === "entry") {
    return;
  }
  const dedupeKey = `${flagKey}:${resolution.kind}`;
  if (loggedResolutions.has(dedupeKey)) {
    return;
  }
  loggedResolutions.add(dedupeKey);
  if (resolution.kind === "missing") {
    logger.error(
      formatSdkErrorMessage({
        code: "FLAG_NOT_FOUND",
        causeSummary: resolution.details.errorMessage ?? "Flag not found in held evaluations",
        remediation: "Confirm the Flag Key exists in this App/Environment, then re-init",
      }),
      { flagKey, targetingKey, errorCode: "FLAG_NOT_FOUND" },
    );
    return;
  }
  if (resolution.kind === "error") {
    logger.error(
      formatSdkErrorMessage({
        code: resolution.details.errorCode ?? "INTERNAL_SERVER_ERROR",
        causeSummary: resolution.details.errorMessage ?? "Held evaluation is ERROR",
        remediation: "Inspect the held errorCode, then re-init after the underlying fault clears",
      }),
      { flagKey, targetingKey, errorCode: resolution.details.errorCode },
    );
    return;
  }
  logger.error(
    formatSdkErrorMessage({
      code: "VALIDATION_ERROR",
      causeSummary: `Held evaluation for ${JSON.stringify(flagKey)} has a null variant with a non-ERROR reason`,
      remediation:
        "Re-init after the Flag's Variants are consistent; the caller's default was returned without recording an Exposure",
    }),
    { flagKey, targetingKey },
  );
}
