import { SplitchSdkError } from "./errors";
import { DEFAULT_ID_TYPE, type EvaluateContext, type Logger, sdkErrorForFailure } from "./evaluate";
import type { EvaluateAllEntry } from "./generated/contract-surface.js";
import type { AttributeValue, Transport } from "./transport";

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
    // Copied, not aliased: the payload travels to the browser client, which
    // deep-equality-checks this context. A caller mutating their own object
    // afterwards must not be able to rewrite what the payload was resolved for.
    attributes: { ...(context.attributes ?? {}) },
  };

  const result = await deps.transport.evaluateAll({
    ...resolved,
    idempotencyKey: context.idempotencyKey ?? mintIdempotencyKey(deps, resolved.targetingKey),
  });

  if (result.status !== 200 || result.evaluations === null || result.etag === null) {
    throw loudly(
      deps,
      resolved.targetingKey,
      sdkErrorForFailure("evaluateAll", result),
      result.cause,
    );
  }

  return { context: resolved, evaluations: result.evaluations, etag: result.etag };
}

/**
 * The batch's billing replay identity (ADR-0033): one key per logical fetch.
 * A caller who retries an uncertain fetch passes their own key to keep the
 * retry free; otherwise the SDK owns it, because callers of a bulk fetch have
 * no Exposure to deduplicate and no reason to mint one.
 *
 * `crypto.randomUUID` is secure-context-only, so a Client Key caller on a plain
 * `http://` page arrives here without it. Refuse loudly: substituting a weaker
 * random source would silently weaken a billing identity, and a bare `TypeError`
 * would break the structured-error contract this accessor advertises.
 */
function mintIdempotencyKey(deps: EvaluateAllDeps, targetingKey: string): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw loudly(
      deps,
      targetingKey,
      new SplitchSdkError({
        code: "SDK_IDEMPOTENCY_KEY_UNAVAILABLE",
        causeSummary:
          "crypto.randomUUID is unavailable in this runtime, so evaluateAll could not mint the batch's replay identity",
        remediation:
          "Pass your own `idempotencyKey` on the context, or serve the page from a secure context (https:// or localhost) where crypto.randomUUID exists",
      }),
    );
  }
  return globalThis.crypto.randomUUID();
}

function loudly(
  deps: EvaluateAllDeps,
  targetingKey: string,
  error: SplitchSdkError,
  cause?: unknown,
): SplitchSdkError {
  deps.logger.error(error.message, {
    targetingKey,
    status: error.status,
    errorCode: error.code,
    // Preserve the underlying error object (name, message, stack) — never truncate.
    cause,
  });
  return error;
}
