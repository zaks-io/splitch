import { formatSdkErrorMessage, SplitchSdkError } from "../errors";
import {
  DEFAULT_ID_TYPE,
  type EvaluateContext,
  type Logger,
  sdkErrorForFailure,
} from "../evaluate";
import type { EvaluateAllEntry, VariantValue } from "../generated/contract-surface.js";
import type { SdkResolutionDetails } from "../resolution";
import type { AttributeValue } from "../transport";
import { ExposureQueue } from "./exposure-queue";
import { type BrowserTransport, createBrowserFetchTransport } from "./transport";

const DEFAULT_ENDPOINT = "https://edge.splitch.dev";
const DEFAULT_TIMEOUT_MS = 5000;
const FALLBACK_DEFAULT_VALUE: VariantValue = false;

/**
 * Options for {@link createSplitchBrowserClient}. Client Key only; one Evaluation
 * Context for the client's lifetime. Construction performs no I/O.
 *
 * `bootstrap` and ETag revalidation polling are out of scope for this slice.
 */
export interface SplitchBrowserClientOptions {
  /** Public Client Key (`pk_…`). A secret `sk_`/`ak_` value throws at construction. */
  readonly clientKey: string;
  /** One Evaluation Context for the client's lifetime (static-context paradigm). */
  readonly context: EvaluateContext;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Test seam: substitute the network adapter without a real fetch. */
  readonly transport?: BrowserTransport;
  /** Test seam: page lifecycle targets for the exposure queue. */
  readonly document?: Document | null;
  readonly window?: Window | null;
}

export type FlagChangeListener = (details: SdkResolutionDetails) => void;

export interface SplitchBrowserClient {
  /** Fetch Precomputed Evaluations once. Idempotent after success. */
  init(): Promise<void>;
  /** Synchronous exposing read of the held Variant value. */
  evaluate(flagKey: string, defaultValue?: VariantValue): VariantValue;
  /** Synchronous exposing read returning full ResolutionDetails. */
  evaluateDetails(flagKey: string, defaultValue?: VariantValue): SdkResolutionDetails;
  /**
   * Per-Flag listener for future revalidation swaps. Subscribing is not a read
   * and fires no Exposure. Accepts keys absent from the held evaluations.
   */
  subscribe(flagKey: string, listener: FlagChangeListener): () => void;
  /** Acknowledged Exposure queue flush; empty queue resolves without network I/O. */
  flush(): Promise<void>;
  /** Final flush; stops timers and page-lifecycle listeners. */
  close(): Promise<void>;
}

interface HeldPayload {
  readonly evaluations: Readonly<Record<string, EvaluateAllEntry>>;
  readonly etag: string;
}

/**
 * Create the static-context browser client. Pass a Client Key only — secrets
 * throw. Call `init()` once, then read Flags synchronously.
 *
 * @see https://splitch.dev/docs/sdk/browser
 */
export function createSplitchBrowserClient(
  options: SplitchBrowserClientOptions,
): SplitchBrowserClient {
  const clientKey = resolveBrowserClientKey(options.clientKey);
  const context = resolveContext(options.context);
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const transport =
    options.transport ??
    createBrowserFetchTransport({
      credential: clientKey,
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: options.fetch ?? globalThis.fetch.bind(globalThis),
    });

  let held: HeldPayload | null = null;
  let initPromise: Promise<void> | null = null;
  const listeners = new Map<string, Set<FlagChangeListener>>();
  const queue = new ExposureQueue({
    transport,
    logger,
    now,
    document: options.document,
    window: options.window,
  });

  function requireHeld(): HeldPayload {
    if (held === null) {
      throw new SplitchSdkError({
        code: "SDK_NOT_INITIALIZED",
        causeSummary:
          "A Flag was read before init() resolved, and no bootstrap payload was supplied",
        remediation: "Await init() before evaluate/evaluateDetails, or pass a matching bootstrap",
      });
    }
    return held;
  }

  function readDetails(flagKey: string, defaultValue: VariantValue): SdkResolutionDetails {
    const payload = requireHeld();
    const entry = payload.evaluations[flagKey];
    if (entry === undefined) {
      return missingFlagDetails(flagKey, defaultValue, context.targetingKey, logger);
    }
    if (entry.reason === "ERROR") {
      return heldErrorDetails(flagKey, entry, defaultValue, context.targetingKey, logger);
    }
    if (entry.exposureTicket !== null) {
      queue.enqueue(flagKey, entry.exposureTicket);
    }
    // Return held Variant values by reference — never clone (React bindings rely on identity).
    return {
      value: entry.variant === null ? defaultValue : entry.variant,
      variantName: entry.variantName,
      reason: entry.reason,
    };
  }

  return {
    async init() {
      if (held !== null) {
        return;
      }
      if (initPromise !== null) {
        return initPromise;
      }
      initPromise = (async () => {
        const idempotencyKey = mintIdempotencyKey(logger, context.targetingKey);
        const result = await transport.evaluateAll({
          targetingKey: context.targetingKey,
          idType: context.idType,
          attributes: context.attributes,
          idempotencyKey,
        });
        if (result.status !== 200 || result.evaluations === null || result.etag === null) {
          throw loudly(
            logger,
            context.targetingKey,
            sdkErrorForFailure("evaluateAll", result),
            result.cause,
          );
        }
        held = { evaluations: result.evaluations, etag: result.etag };
      })();
      try {
        await initPromise;
      } catch (error) {
        initPromise = null;
        throw error;
      }
    },

    evaluate(flagKey, defaultValue = FALLBACK_DEFAULT_VALUE) {
      return readDetails(flagKey, defaultValue).value;
    },

    evaluateDetails(flagKey, defaultValue = FALLBACK_DEFAULT_VALUE) {
      return readDetails(flagKey, defaultValue);
    },

    subscribe(flagKey, listener) {
      let set = listeners.get(flagKey);
      if (set === undefined) {
        set = new Set();
        listeners.set(flagKey, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) {
          listeners.delete(flagKey);
        }
      };
    },

    async flush() {
      await queue.flush();
    },

    async close() {
      await queue.close();
      listeners.clear();
    },
  };
}

function resolveBrowserClientKey(clientKey: string): string {
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
  return clientKey;
}

function resolveContext(context: EvaluateContext): {
  targetingKey: string;
  idType: string;
  attributes: Readonly<Record<string, AttributeValue>>;
} {
  if (typeof context.targetingKey !== "string" || context.targetingKey.length === 0) {
    throw new SplitchSdkError({
      code: "SDK_CREDENTIAL_CONFIGURATION_INVALID",
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

function mintIdempotencyKey(logger: Logger, targetingKey: string): string {
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

function loudly(
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

function missingFlagDetails(
  flagKey: string,
  defaultValue: VariantValue,
  targetingKey: string,
  logger: Logger,
): SdkResolutionDetails {
  const details: SdkResolutionDetails = {
    value: defaultValue,
    variantName: null,
    reason: "ERROR",
    errorCode: "FLAG_NOT_FOUND",
    errorMessage: `Flag key ${JSON.stringify(flagKey)} is absent from the held Precomputed Evaluations`,
  };
  logger.error(
    formatSdkErrorMessage({
      code: "FLAG_NOT_FOUND",
      causeSummary: details.errorMessage ?? "Flag not found in held evaluations",
      remediation: "Confirm the Flag Key exists in this App/Environment, then re-init",
    }),
    { flagKey, targetingKey, errorCode: "FLAG_NOT_FOUND" },
  );
  return details;
}

function heldErrorDetails(
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
