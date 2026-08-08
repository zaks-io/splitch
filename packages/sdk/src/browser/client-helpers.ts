import { formatSdkErrorMessage, SplitchSdkError } from "../errors";
import { DEFAULT_ID_TYPE, type EvaluateContext, type Logger } from "../evaluate";
import type { EvaluateAllEntry, VariantValue } from "../generated/contract-surface.js";
import type { SdkResolutionDetails } from "../resolution";
import type { AttributeValue } from "../transport";

export function resolveBrowserClientKey(clientKey: string): string {
  if (typeof clientKey !== "string" || clientKey.length === 0) {
    throw new SplitchSdkError({
      code: "SDK_CREDENTIAL_CONFIGURATION_INVALID",
      causeSummary: "The browser client requires a non-empty clientKey",
      remediation: "Pass the pk_… key material from `splitch client-key get`",
    });
  }
  // Secrets must never reach a browser bundle. Prefix check is the construction gate.
  if (clientKey.startsWith("sk_") || clientKey.startsWith("ak_")) {
    throw new SplitchSdkError({
      code: "SDK_CREDENTIAL_CONFIGURATION_INVALID",
      causeSummary: "A secret API Key was passed to the browser client",
      remediation: "Pass a public Client Key (pk_…); keep sk_/ak_ secrets on the server",
    });
  }
  // ck_ is the Client Key *id*, not the key material — the top pasting mistake.
  if (clientKey.startsWith("ck_")) {
    throw new SplitchSdkError({
      code: "SDK_CREDENTIAL_CONFIGURATION_INVALID",
      causeSummary: "A Client Key id (ck_…) was passed where key material is required",
      remediation: "Pass the pk_… keyMaterial from `splitch client-key get`, not the ck_… keyId",
    });
  }
  return clientKey;
}

export function resolveContext(context: EvaluateContext): {
  targetingKey: string;
  idType: string;
  attributes: Readonly<Record<string, AttributeValue>>;
} {
  if (typeof context.targetingKey !== "string" || context.targetingKey.length === 0) {
    throw new SplitchSdkError({
      code: "SDK_CONTEXT_INVALID",
      causeSummary: "The browser client requires a non-empty targetingKey on context",
      remediation: "Pass context: { targetingKey: … } at construction",
    });
  }
  return {
    targetingKey: context.targetingKey,
    idType: context.idType ?? DEFAULT_ID_TYPE,
    attributes: Object.fromEntries(
      Object.entries(context.attributes ?? {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value] : value,
      ]),
    ),
  };
}

export function mintIdempotencyKey(logger: Logger, targetingKey: string): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw loudly(
      logger,
      targetingKey,
      new SplitchSdkError({
        code: "SDK_IDEMPOTENCY_KEY_UNAVAILABLE",
        causeSummary:
          "crypto.randomUUID is unavailable, so init() could not mint the batch's replay identity",
        remediation:
          "Serve the page from a secure context (https:// or localhost) where crypto.randomUUID exists",
      }),
    );
  }
  return globalThis.crypto.randomUUID();
}

export function loudly(
  logger: Logger,
  targetingKey: string,
  error: SplitchSdkError,
  cause?: unknown,
): SplitchSdkError {
  logger.error(error.message, {
    targetingKey,
    status: error.status,
    errorCode: error.code,
    cause,
  });
  return error;
}

export function missingFlagDetails(
  flagKey: string,
  defaultValue: VariantValue,
  targetingKey: string,
  logger: Logger,
  loggedMissing: Set<string>,
): SdkResolutionDetails {
  const details: SdkResolutionDetails = {
    value: defaultValue,
    variantName: null,
    reason: "ERROR",
    errorCode: "FLAG_NOT_FOUND",
    errorMessage: `Flag key ${JSON.stringify(flagKey)} is absent from the held Precomputed Evaluations`,
  };
  if (!loggedMissing.has(flagKey)) {
    loggedMissing.add(flagKey);
    logger.error(
      formatSdkErrorMessage({
        code: "FLAG_NOT_FOUND",
        causeSummary: details.errorMessage ?? "Flag not found in held evaluations",
        remediation: "Confirm the Flag Key exists in this App/Environment, then re-init",
      }),
      { flagKey, targetingKey, errorCode: "FLAG_NOT_FOUND" },
    );
  }
  return details;
}

export function heldErrorDetails(
  flagKey: string,
  entry: EvaluateAllEntry,
  defaultValue: VariantValue,
  targetingKey: string,
  logger: Logger,
): SdkResolutionDetails {
  const details: SdkResolutionDetails = {
    value: defaultValue,
    variantName: null,
    reason: "ERROR",
    errorCode: entry.errorCode ?? "INTERNAL_SERVER_ERROR",
    errorMessage: `Held evaluation for ${JSON.stringify(flagKey)} carries reason ERROR`,
  };
  logger.error(
    formatSdkErrorMessage({
      code: details.errorCode ?? "INTERNAL_SERVER_ERROR",
      causeSummary: details.errorMessage ?? "Held evaluation is ERROR",
      remediation: "Inspect the held errorCode, then re-init after the underlying fault clears",
    }),
    { flagKey, targetingKey, errorCode: details.errorCode },
  );
  return details;
}

/**
 * Match the root client's null-variant treatment: DEFAULT, no arm label, no Exposure.
 * A Split with a null variant is a server-side arm mismatch, not a served treatment.
 */
export function nullVariantDetails(
  flagKey: string,
  defaultValue: VariantValue,
  targetingKey: string,
  logger: Logger,
): SdkResolutionDetails {
  logger.error(
    formatSdkErrorMessage({
      code: "VALIDATION_ERROR",
      causeSummary: `Held evaluation for ${JSON.stringify(flagKey)} has a null variant with a non-ERROR reason`,
      remediation:
        "Re-init after the Flag's arms are consistent; the caller's default was returned without recording an Exposure",
    }),
    { flagKey, targetingKey },
  );
  return {
    value: defaultValue,
    variantName: null,
    reason: "DEFAULT",
  };
}
