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
 * that Flag would create a new Exposure, never Targeting Rules, allocation
 * fractions, or the salt. The object is what the browser client consumes as its
 * `bootstrap`.
 *
 * `context` echoes the Evaluation Context this was resolved for, `targetingKey`
 * and every attribute included, so the browser client can prove it is hydrating
 * its own Entity's results. Serializing the payload into a page publishes those
 * attributes: pass only attributes you would publish.
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
    attributes: copyAttributes(context.attributes),
  };

  const result = await deps.transport.evaluateAll({
    ...resolved,
    // An empty string is an absent key, not a key. `??` alone would forward it
    // and let the edge reject what the SDK could refuse here.
    idempotencyKey:
      context.idempotencyKey === undefined || context.idempotencyKey.length === 0
        ? mintIdempotencyKey(deps, resolved.targetingKey)
        : context.idempotencyKey,
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
 * Detaches the map and each array value from the caller's object, so a caller
 * mutating what they passed cannot afterwards rewrite what the payload claims it
 * was resolved for. That matters because the browser client deep-equality-checks
 * this context.
 *
 * The guarantee stops one array level down. `AttributeValue` types array elements
 * as `unknown`, so `{ tags: [{ nested: "x" }] }` still shares the inner object and
 * a caller can mutate through it. Narrowing the element type to the scalar union
 * would close that by construction, but it changes a public type used by every
 * accessor, so it is being decided with the bootstrap deep-equality check in
 * SPL-332 rather than here.
 */
function copyAttributes(
  attributes: Readonly<Record<string, AttributeValue>> | undefined,
): Readonly<Record<string, AttributeValue>> {
  return Object.fromEntries(
    Object.entries(attributes ?? {}).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
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
