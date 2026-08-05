import { formatSdkErrorMessage, SplitchSdkError } from "./errors";
import type { VariantValue } from "./generated/contract-surface.js";
import { errorCodeForStatus, type SdkResolutionDetails, synthesizeDetails } from "./resolution";
import type { SeenSet } from "./seen-set";
import type { AttributeValue, Transport, TransportFailure, TransportRequest } from "./transport";

/**
 * Context for the Exposure-bearing `evaluate` / `evaluateDetails` calls.
 * `idType` defaults to `'user'` (the common case buckets on users).
 * `defaultValue` is the Default Variant returned on every ERROR and on a 200
 * no-match, so the host app always renders something.
 *
 * `attributes` allows scalars or arrays only, never a nested object; a nested
 * object is a compile error here rather than a runtime 400.
 */
export interface EvaluationContext {
  readonly targetingKey: string;
  readonly idType?: string;
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
  readonly defaultValue?: VariantValue;
  /**
   * Caller-owned id for one logical Evaluation: generate once per evaluation
   * and reuse it on every retry so the platform deduplicates the Exposure.
   */
  readonly idempotencyKey: string;
}

/** Context for the non-Exposure calls `peekVariant` and `verify`. */
export interface EvaluateContext {
  readonly targetingKey: string;
  readonly idType?: string;
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
  readonly defaultValue?: VariantValue;
  /** Optional because peek and verify do not write billable usage. */
  readonly idempotencyKey?: string;
}

/**
 * Loud-log sink, defaulting to `console`. The SDK reports every
 * failure-fallback through `error` (a failure is always observable, never a
 * silent default) and Exposure-suppressing cache hits through `debug`.
 */
export interface Logger {
  error(message: string, detail: unknown): void;
  debug(message: string, detail: unknown): void;
}

export interface EvaluateDeps {
  readonly transport: Transport;
  readonly seenSet: SeenSet;
  readonly logger: Logger;
  /** Epoch-ms clock; injected so the seen-set TTL is testable without real time. */
  readonly now: () => number;
}

const DEFAULT_ID_TYPE = "user";
// The Default Variant value when the caller supplies none. `false` is the safe
// off-state for the canonical boolean flag.
const FALLBACK_DEFAULT_VALUE: VariantValue = false;

const SERVER_ERROR_REMEDIATION =
  "Correct the request or credential described by the error, then retry the operation";

function sdkErrorForFailure(operation: string, result: TransportFailure): SplitchSdkError {
  const code = result.errorCode ?? errorCodeForStatus(result.status);
  return new SplitchSdkError({
    code,
    causeSummary: result.errorMessage ?? `${operation} failed with ${code}`,
    remediation: SERVER_ERROR_REMEDIATION,
    status: result.status,
    originalError: result.cause,
  });
}

function requestFor(flagKey: string, context: EvaluateContext): TransportRequest {
  return {
    flagKey,
    targetingKey: context.targetingKey,
    idType: context.idType ?? DEFAULT_ID_TYPE,
    attributes: context.attributes ?? {},
    ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
  };
}

function logEvaluateError(
  deps: EvaluateDeps,
  flagKey: string,
  targetingKey: string,
  details: SdkResolutionDetails,
  status: number | null,
  cause?: unknown,
): void {
  deps.logger.error(
    formatSdkErrorMessage({
      code: details.errorCode ?? errorCodeForStatus(status),
      causeSummary: "Evaluation failed loud to the Default Variant",
      remediation: SERVER_ERROR_REMEDIATION,
      status,
      originalError: cause,
    }),
    {
      flagKey,
      targetingKey,
      status,
      errorCode: details.errorCode,
      // Preserve the underlying error object (name, message, stack) — never truncate.
      cause,
    },
  );
}

function replayCachedHit(
  deps: EvaluateDeps,
  flagKey: string,
  context: EvaluationContext,
  cached: { variant: VariantValue | null; variantName: string | null },
  defaultValue: VariantValue,
): SdkResolutionDetails {
  deps.logger.debug("[splitch] seen-set hit: suppress Exposure", {
    flagKey,
    targetingKey: context.targetingKey,
  });
  const recordCachedEvaluation = deps.transport.recordCachedEvaluation;
  if (recordCachedEvaluation) {
    void recordCachedEvaluation({ flagKey, idempotencyKey: context.idempotencyKey }).catch(
      (cause) => {
        const error =
          cause instanceof SplitchSdkError
            ? cause
            : new SplitchSdkError({
                code: "SDK_CACHED_TELEMETRY_FAILED",
                causeSummary:
                  cause instanceof Error
                    ? cause.message
                    : "Cached Evaluation telemetry failed with a non-error rejection",
                remediation: "Check data-plane availability before retrying the logical Evaluation",
                originalError: cause,
              });
        deps.logger.error(error.message, { flagKey, errorCode: error.code });
      },
    );
  }
  // A cached `variant: null` records a 200 no-match; re-apply THIS call's
  // Default Variant rather than replaying a previous caller's. The arm label
  // is replayed as stored, so a CACHED result names the same arm the live
  // resolution did.
  return {
    value: cached.variant ?? defaultValue,
    variantName: cached.variantName,
    reason: "CACHED",
  };
}

/**
 * Same Entity/Run already exposed within the TTL, but attributes changed.
 * Re-resolve through verify so Targeting sees the new context without a second
 * billable Exposure (seen-set.md: Exposure key excludes attributes).
 */
async function resolveContextMiss(
  deps: EvaluateDeps,
  flagKey: string,
  context: EvaluationContext,
  idType: string,
  attributes: Readonly<Record<string, AttributeValue>>,
  defaultValue: VariantValue,
  runId: string,
): Promise<SdkResolutionDetails> {
  const { targetingKey } = context;
  deps.logger.debug("[splitch] seen-set context-miss: re-resolve without Exposure", {
    flagKey,
    targetingKey,
  });
  const verified = await deps.transport.verify(requestFor(flagKey, context));
  const details =
    verified.details ??
    synthesizeDetails(
      {
        status: verified.status,
        variant: null,
        variantName: null,
        runId: null,
        errorCode: verified.errorCode,
        errorMessage: verified.errorMessage,
        cause: verified.cause,
      },
      defaultValue,
    );

  if (details.reason === "ERROR") {
    logEvaluateError(deps, flagKey, targetingKey, details, verified.status, verified.cause);
    return details;
  }

  // Store under the new attribute fingerprint; Exposure slot stays the same.
  // Preserve the resolved value for every non-ERROR reason (including DEFAULT
  // and DISABLED). Collapsing those to null would make a later CACHED replay
  // substitute context.defaultValue and return a different result for identical
  // inputs — the defect this slice exists to prevent.
  deps.seenSet.set(
    flagKey,
    runId,
    idType,
    targetingKey,
    attributes,
    {
      variant: details.value,
      variantName: details.variantName ?? null,
    },
    deps.now(),
  );
  return details;
}

/**
 * The single evaluate path shared by `evaluate` and `evaluateDetails`. Ordering
 * follows docs/spec/sdk/exposure-accessor.md and seen-set.md:
 *
 *   1. Default idType to 'user'; resolve the Default Variant value.
 *   2. Seen-set value hit: a FRESH (within-TTL) entry for this
 *      (flagKey, idType, targetingKey, attributes) replays as CACHED with NO
 *      transport call and NO second Exposure. Bounded optimistic suppression —
 *      past the revalidation window the entry is treated as a MISS so a Run
 *      boundary is detected within the TTL (see seen-set.md), never suppressed
 *      forever.
 *   3. Seen-set context-miss: Exposure identity is still fresh but attributes
 *      differ → re-resolve via `verify` (no Exposure) and cache the new value
 *      under its attribute fingerprint. Never replay another context's Variant.
 *   4. Miss -> call the transport ONCE (the server fires the Exposure as a side
 *      effect). NEVER retried — a retry is a fresh resolution, not a replay.
 *   5. ERROR -> return Default Variant + reason:ERROR + errorCode, emit a LOUD
 *      log, do NOT cache (never cache an error), fire NO Exposure.
 *   6. Success -> record (flagKey, runId, targetingKey, attributes, storedAt) ->
 *      value. A later call past the TTL that returns a NEW runId stores a new
 *      Exposure slot, so a Run boundary fires a fresh Exposure.
 */
export async function runEvaluate(
  deps: EvaluateDeps,
  flagKey: string,
  context: EvaluationContext,
): Promise<SdkResolutionDetails> {
  const { targetingKey } = context;
  const idType = context.idType ?? DEFAULT_ID_TYPE;
  const defaultValue = context.defaultValue ?? FALLBACK_DEFAULT_VALUE;
  const attributes = context.attributes ?? {};

  const lookup = deps.seenSet.get(flagKey, idType, targetingKey, attributes, deps.now());
  if (lookup.kind === "hit") {
    return replayCachedHit(deps, flagKey, context, lookup.entry, defaultValue);
  }
  if (lookup.kind === "context-miss") {
    return resolveContextMiss(
      deps,
      flagKey,
      context,
      idType,
      attributes,
      defaultValue,
      lookup.runId,
    );
  }

  const result = await deps.transport.evaluate({
    ...requestFor(flagKey, context),
  });

  const details = synthesizeDetails(result, defaultValue);

  if (details.reason === "ERROR") {
    // Loud, never silent: observable in logs AND via the ERROR reason the caller
    // branches on. No cache write, no Exposure, no retry.
    logEvaluateError(deps, flagKey, targetingKey, details, result.status, result.cause);
    return details;
  }

  // A 200 carries a runId (transport contract). Without one the seen-set cannot
  // key the entry, so skip caching rather than guess — correctness over the cache.
  // The WIRE variant is stored (null on a no-match), never the caller-supplied
  // defaultValue — a per-call default must not leak into other call sites.
  if (result.runId !== null) {
    deps.seenSet.set(
      flagKey,
      result.runId,
      idType,
      targetingKey,
      attributes,
      { variant: result.variant, variantName: result.variantName },
      deps.now(),
    );
  }
  return details;
}

export async function runPeekVariant(
  deps: EvaluateDeps,
  flagKey: string,
  context: EvaluateContext,
): Promise<VariantValue> {
  const result = await deps.transport.peek(requestFor(flagKey, context));

  if (result.status === 200 && result.variant !== null) {
    return result.variant;
  }

  const error = sdkErrorForFailure("peekVariant", result);
  deps.logger.error(error.message, {
    flagKey,
    targetingKey: context.targetingKey,
    status: error.status,
    errorCode: error.code,
    cause: result.cause,
  });
  throw error;
}

export async function runVerify(
  deps: EvaluateDeps,
  flagKey: string,
  context: EvaluateContext,
): Promise<SdkResolutionDetails> {
  const defaultValue = context.defaultValue ?? FALLBACK_DEFAULT_VALUE;
  const result = await deps.transport.verify(requestFor(flagKey, context));
  const details =
    result.details ??
    synthesizeDetails(
      {
        status: result.status,
        variant: null,
        variantName: null,
        runId: null,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        cause: result.cause,
      },
      defaultValue,
    );

  if (details.reason === "ERROR") {
    deps.logger.error(
      formatSdkErrorMessage({
        code: details.errorCode ?? errorCodeForStatus(result.status),
        causeSummary: "Verification failed loud to the Default Variant",
        remediation: SERVER_ERROR_REMEDIATION,
        status: result.status,
        originalError: result.cause,
      }),
      {
        flagKey,
        targetingKey: context.targetingKey,
        status: result.status,
        errorCode: details.errorCode,
        cause: result.cause,
      },
    );
  }

  return details;
}
