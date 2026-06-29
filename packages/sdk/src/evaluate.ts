import type { ResolutionDetails, VariantValue } from "@splitch/contracts";
import { synthesizeDetails } from "./resolution.js";
import type { SeenSet } from "./seen-set.js";
import type { AttributeValue, Transport } from "./transport.js";

/**
 * Caller-facing evaluate options. `idType` defaults to `'user'` client-side (the
 * common case buckets on users); the wire request always carries the field.
 * `defaultValue` is the Default Variant returned on every ERROR and on a 200
 * no-match — the host app always renders something (CONTEXT.md: Default Variant).
 *
 * `attributes` mirrors the contract's `EvaluationContext.attributes`: scalars or
 * arrays only (no nested objects), so a nested-object attribute is a COMPILE error
 * here rather than a runtime 400 (DataPlaneEvaluateRequestSchema).
 */
export interface EvaluateContext {
  readonly targetingKey: string;
  readonly idType?: string;
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
  readonly defaultValue?: VariantValue;
}

/**
 * Loud-log sink. Defaults to `console`; injectable so tests can assert the loud
 * log fired on a failure-fallback (the "loud" half of fail-loud, ADR-0036) and
 * the DEBUG log fired on a seen-set hit (seen-set.md §"Debug logging requirement").
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
  context: EvaluateContext,
): Promise<ResolutionDetails> {
  const { targetingKey } = context;
  const defaultValue = context.defaultValue ?? FALLBACK_DEFAULT_VALUE;

  const cached = deps.seenSet.get(flagKey, targetingKey, deps.now());
  if (cached !== undefined) {
    deps.logger.debug("[splitch] seen-set hit: suppress Exposure", { flagKey, targetingKey });
    return { value: cached, variantName: null, reason: "CACHED" };
  }

  const result = await deps.transport.evaluate({
    flagKey,
    targetingKey,
    idType: context.idType ?? DEFAULT_ID_TYPE,
    attributes: context.attributes ?? {},
  });

  const details = synthesizeDetails(result, defaultValue);

  if (details.reason === "ERROR") {
    // Loud, never silent: observable in logs AND via the ERROR reason the caller
    // branches on. No cache write, no Exposure, no retry.
    deps.logger.error("[splitch] evaluate failed-loud to Default Variant", {
      flagKey,
      targetingKey,
      status: result.status,
      errorCode: details.errorCode,
    });
    return details;
  }

  // A 200 carries a runId (transport contract). Without one the seen-set cannot
  // key the entry, so skip caching rather than guess — correctness over the cache.
  if (result.runId !== null) {
    deps.seenSet.set(flagKey, result.runId, targetingKey, details.value, deps.now());
  }
  return details;
}
