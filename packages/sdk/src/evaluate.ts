import type { ResolutionDetails, VariantValue } from "./generated/contract-surface.js";
import { formatSdkErrorMessage, SplitchSdkError } from "./errors";
import { errorCodeForStatus, synthesizeDetails } from "./resolution";
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
    cause: result.errorMessage ?? `${operation} failed with ${code}`,
    remediation: SERVER_ERROR_REMEDIATION,
    status: result.status,
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

/**
 * The single evaluate path shared by `evaluate` and `evaluateDetails`. Ordering
 * follows docs/spec/sdk/exposure-accessor.md and seen-set.md:
 *
 *   1. Default idType to 'user'; resolve the Default Variant value.
 *   2. Seen-set short-circuit: a FRESH (within-TTL) entry for this
 *      (flagKey, targetingKey) replays as CACHED with NO transport call and NO
 *      second Exposure. Bounded optimistic suppression — past the revalidation
 *      window the entry is treated as a MISS so a Run boundary is detected within
 *      the TTL (see seen-set.md), never suppressed forever.
 *   3. Miss -> call the transport ONCE (the server fires the Exposure as a side
 *      effect). NEVER retried — a retry is a fresh resolution, not a replay.
 *   4. ERROR -> return Default Variant + reason:ERROR + errorCode, emit a LOUD
 *      log, do NOT cache (never cache an error), fire NO Exposure.
 *   5. Success -> record (flagKey, runId, targetingKey, storedAt) -> value. A
 *      later call past the TTL that returns a NEW runId stores a new triple, so a
 *      Run boundary fires a fresh Exposure (the prior entry no longer matches).
 */
export async function runEvaluate(
  deps: EvaluateDeps,
  flagKey: string,
  context: EvaluationContext,
): Promise<ResolutionDetails> {
  const { targetingKey } = context;
  const idType = context.idType ?? DEFAULT_ID_TYPE;
  const defaultValue = context.defaultValue ?? FALLBACK_DEFAULT_VALUE;

  const cached = deps.seenSet.get(flagKey, idType, targetingKey, deps.now());
  if (cached !== undefined) {
    deps.logger.debug("[splitch] seen-set hit: suppress Exposure", { flagKey, targetingKey });
    const recordCachedEvaluation = deps.transport.recordCachedEvaluation;
    if (recordCachedEvaluation) {
      void recordCachedEvaluation({ flagKey, idempotencyKey: context.idempotencyKey }).catch(
        (cause) => {
          const error =
            cause instanceof SplitchSdkError
              ? cause
              : new SplitchSdkError({
                  code: "SDK_CACHED_TELEMETRY_FAILED",
                  cause:
                    cause instanceof Error
                      ? cause.message
                      : "Cached Evaluation telemetry failed with a non-error rejection",
                  remediation:
                    "Check data-plane availability before retrying the logical Evaluation",
                });
          deps.logger.error(error.message, { flagKey, errorCode: error.code });
        },
      );
    }
    // A cached `variant: null` records a 200 no-match; re-apply THIS call's
    // Default Variant rather than replaying a previous caller's.
    return { value: cached.variant ?? defaultValue, variantName: null, reason: "CACHED" };
  }

  const result = await deps.transport.evaluate({
    ...requestFor(flagKey, context),
  });

  const details = synthesizeDetails(result, defaultValue);

  if (details.reason === "ERROR") {
    // Loud, never silent: observable in logs AND via the ERROR reason the caller
    // branches on. No cache write, no Exposure, no retry.
    deps.logger.error(
      formatSdkErrorMessage({
        code: details.errorCode ?? errorCodeForStatus(result.status),
        cause: "Evaluation failed loud to the Default Variant",
        remediation: SERVER_ERROR_REMEDIATION,
        status: result.status,
      }),
      {
        flagKey,
        targetingKey,
        status: result.status,
        errorCode: details.errorCode,
      },
    );
    return details;
  }

  // A 200 carries a runId (transport contract). Without one the seen-set cannot
  // key the entry, so skip caching rather than guess — correctness over the cache.
  // The WIRE variant is stored (null on a no-match), never the caller-supplied
  // defaultValue — a per-call default must not leak into other call sites.
  if (result.runId !== null) {
    deps.seenSet.set(flagKey, result.runId, idType, targetingKey, result.variant, deps.now());
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
  });
  throw error;
}

export async function runVerify(
  deps: EvaluateDeps,
  flagKey: string,
  context: EvaluateContext,
): Promise<ResolutionDetails> {
  const defaultValue = context.defaultValue ?? FALLBACK_DEFAULT_VALUE;
  const result = await deps.transport.verify(requestFor(flagKey, context));
  const details =
    result.details ??
    synthesizeDetails(
      {
        status: result.status,
        variant: null,
        runId: null,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      },
      defaultValue,
    );

  if (details.reason === "ERROR") {
    deps.logger.error(
      formatSdkErrorMessage({
        code: details.errorCode ?? errorCodeForStatus(result.status),
        cause: "Verification failed loud to the Default Variant",
        remediation: SERVER_ERROR_REMEDIATION,
        status: result.status,
      }),
      {
        flagKey,
        targetingKey: context.targetingKey,
        status: result.status,
        errorCode: details.errorCode,
      },
    );
  }

  return details;
}
