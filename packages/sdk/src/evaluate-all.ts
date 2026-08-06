import type { SplitchSdkError } from "./errors";
import { DEFAULT_ID_TYPE, type EvaluateContext, type Logger, sdkErrorForFailure } from "./evaluate";
import type { EvaluateAllEntry } from "./generated/contract-surface.js";
import type { AttributeValue, EvaluateAllTransportResult, Transport } from "./transport";

/**
 * The Evaluation Context a Precomputed Evaluations payload was resolved for,
 * with the SDK's defaults already applied. It travels with the payload so a
 * client hydrating from it can prove it is holding its own Entity's results
 * rather than someone else's.
 */
export interface PrecomputedEvaluationsContext {
  readonly targetingKey: string;
  readonly idType: string;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
}

/**
 * Every Flag in the credential's App and Environment resolved for one
 * Evaluation Context, plus the strong validator the payload was tagged with.
 *
 * Keyed by Flag Key. Each entry carries the resolved value, the immutable
 * Variant name, a non-revealing `reason`, and an Exposure Ticket when reading
 * that Flag would create a new Exposure — never Targeting Rules, allocation
 * fractions, or the salt. That makes the object safe to serialize into a page,
 * which is exactly what the browser client consumes as its `bootstrap`.
 */
export interface PrecomputedEvaluations {
  readonly context: PrecomputedEvaluationsContext;
  readonly evaluations: Readonly<Record<string, EvaluateAllEntry>>;
  readonly etag: string;
}

/**
 * Narrower than `EvaluateDeps` on purpose: `evaluateAll` has no seen-set and no
 * clock, so it structurally cannot fire, suppress, or cache an Exposure.
 */
export interface EvaluateAllDeps {
  readonly transport: Pick<Transport, "evaluateAll">;
  readonly logger: Logger;
}

/**
 * One round trip for the whole Flag set. Non-exposing: the route mints Exposure
 * Tickets instead of sealing Exposures, and nothing here touches the seen-set.
 *
 * Throws rather than degrading. There is no per-Flag Default Variant to fall
 * back to at this level, and a half-known payload silently standing in for a
 * real one is exactly the disguised failure ADR-0036 forbids — the caller gets
 * a structured `SplitchSdkError` and a loud log.
 */
export async function runEvaluateAll(
  deps: EvaluateAllDeps,
  context: EvaluateContext,
): Promise<PrecomputedEvaluations> {
  const resolved: PrecomputedEvaluationsContext = {
    targetingKey: context.targetingKey,
    idType: context.idType ?? DEFAULT_ID_TYPE,
    attributes: context.attributes ?? {},
  };

  const result = await deps.transport.evaluateAll({
    ...resolved,
    // The batch's billing replay identity (ADR-0033): one key per logical fetch.
    // A caller who retries an uncertain fetch passes their own key to keep the
    // retry free; otherwise the SDK owns it, because callers of a bulk fetch
    // have no Exposure to deduplicate and no reason to mint one.
    idempotencyKey: context.idempotencyKey ?? crypto.randomUUID(),
  });

  if (result.status !== 200 || result.evaluations === null || result.etag === null) {
    throw loudFailure(deps, resolved.targetingKey, result);
  }

  return { context: resolved, evaluations: result.evaluations, etag: result.etag };
}

function loudFailure(
  deps: EvaluateAllDeps,
  targetingKey: string,
  result: EvaluateAllTransportResult,
): SplitchSdkError {
  const error = sdkErrorForFailure("evaluateAll", result);
  deps.logger.error(error.message, {
    targetingKey,
    status: error.status,
    errorCode: error.code,
    // Preserve the underlying error object (name, message, stack) — never truncate.
    cause: result.cause,
  });
  return error;
}
