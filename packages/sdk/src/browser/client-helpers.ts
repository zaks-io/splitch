import { formatSdkErrorMessage, SplitchSdkError } from "../errors";
import { DEFAULT_ID_TYPE, type EvaluateContext, type Logger } from "../evaluate";
import type { PrecomputedEvaluations } from "../evaluate-all";
import {
  type EvaluateAllEntry,
  EvaluateAllResponseSchema,
  type VariantValue,
} from "../generated/contract-surface.js";
import type { SdkResolutionDetails } from "../resolution";
import type { AttributeValue } from "../transport";
import { canonicalEqual, type HeldPayload, type ListenerFailure } from "./payload-store";

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
        Array.isArray(value) ? value.map(detachNested) : value,
      ]),
    ),
  };
}

function detachNested(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(detachNested);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, detachNested(nested)]),
    );
  }
  return value;
}

export function resolveBootstrap(
  bootstrap: PrecomputedEvaluations,
  context: ReturnType<typeof resolveContext>,
): HeldPayload {
  if (typeof bootstrap !== "object" || bootstrap === null || Array.isArray(bootstrap)) {
    throw new SplitchSdkError({
      code: "VALIDATION_ERROR",
      causeSummary: "The browser bootstrap must be a server-generated object",
      remediation: "Regenerate the bootstrap payload server-side with the SDK evaluateAll accessor",
    });
  }
  if (!canonicalEqual(bootstrap.context, context)) {
    throw new SplitchSdkError({
      code: "SDK_BOOTSTRAP_CONTEXT_MISMATCH",
      causeSummary: "The bootstrap Evaluation Context does not match the browser client's context",
      remediation:
        "Generate bootstrap for the same targetingKey, idType, and attributes passed to createSplitchBrowserClient",
    });
  }
  if (typeof bootstrap.etag !== "string" || bootstrap.etag.length === 0) {
    throw new SplitchSdkError({
      code: "VALIDATION_ERROR",
      causeSummary: "The browser bootstrap is missing its non-empty etag",
      remediation: "Pass the complete object returned by the server SDK's evaluateAll accessor",
    });
  }
  let parsed: ReturnType<typeof EvaluateAllResponseSchema.parse>;
  try {
    parsed = EvaluateAllResponseSchema.parse({ evaluations: bootstrap.evaluations });
  } catch (cause) {
    throw new SplitchSdkError({
      code: "VALIDATION_ERROR",
      causeSummary:
        cause instanceof Error ? cause.message : "The browser bootstrap evaluations are invalid",
      remediation: "Regenerate the bootstrap payload server-side with the SDK evaluateAll accessor",
      originalError: cause,
    });
  }
  return { evaluations: parsed.evaluations, etag: bootstrap.etag };
}

export function resolveRevalidateMs(value: number | undefined, defaultValue: number): number {
  const resolved = value ?? defaultValue;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new SplitchSdkError({
      code: "VALIDATION_ERROR",
      causeSummary: "revalidateMs must be a finite non-negative duration",
      remediation: "Pass milliseconds greater than or equal to zero; use 0 to disable revalidation",
    });
  }
  return resolved;
}

export function logListenerFailures(logger: Logger, failures: readonly ListenerFailure[]): void {
  for (const { flagKey, cause } of failures) {
    logger.error(
      formatSdkErrorMessage({
        code: "VALIDATION_ERROR",
        causeSummary: `Flag change listener for ${JSON.stringify(flagKey)} threw`,
        remediation:
          "Fix the listener; the new payload is active and other listeners were still notified",
      }),
      { flagKey, cause },
    );
  }
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
 * Match the root client's null-variant treatment: DEFAULT, no Variant name, no Exposure.
 * A Split with a null Variant is a server-side Variant mismatch, not a served treatment.
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
        "Re-init after the Flag's Variants are consistent; the caller's default was returned without recording an Exposure",
    }),
    { flagKey, targetingKey },
  );
  return {
    value: defaultValue,
    variantName: null,
    reason: "DEFAULT",
  };
}
