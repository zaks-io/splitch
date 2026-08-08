import { SplitchSdkError } from "../errors";
import type { EvaluateContext, Logger } from "../evaluate";
import { sdkErrorForFailure } from "../evaluate";
import type {
  EvaluateAllEntry,
  ExposureBatchResult,
  VariantValue,
} from "../generated/contract-surface.js";
import type { SdkResolutionDetails } from "../resolution";
import {
  heldErrorDetails,
  loudly,
  mintIdempotencyKey,
  missingFlagDetails,
  nullVariantDetails,
  resolveBrowserClientKey,
  resolveContext,
} from "./client-helpers";
import { ExposureQueue } from "./exposure-queue";
import { type FlagChangeListener, registerFlagListener } from "./subscribe";
import { type BrowserTransport, createBrowserFetchTransport } from "./transport";

const DEFAULT_ENDPOINT = "https://edge.splitch.dev";
const DEFAULT_TIMEOUT_MS = 5000;
const FALLBACK_DEFAULT_VALUE: VariantValue = false;

export type { FlagChangeListener } from "./subscribe";

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
  /** Acknowledged Exposure queue flush; resolves with per-item results. */
  flush(): Promise<readonly ExposureBatchResult[]>;
  /** Final flush; stops timers and page-lifecycle listeners. */
  close(): Promise<readonly ExposureBatchResult[]>;
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
  const loggedMissing = new Set<string>();
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
      return missingFlagDetails(flagKey, defaultValue, context.targetingKey, logger, loggedMissing);
    }
    if (entry.reason === "ERROR") {
      return heldErrorDetails(flagKey, entry, defaultValue, context.targetingKey, logger);
    }
    if (entry.variant === null) {
      return nullVariantDetails(flagKey, defaultValue, context.targetingKey, logger);
    }
    if (entry.exposureTicket !== null) {
      queue.enqueue(flagKey, entry.exposureTicket);
    }
    // Return held Variant values by reference — never clone (React bindings rely on identity).
    return {
      value: entry.variant,
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
      return registerFlagListener(listeners, flagKey, listener);
    },

    async flush() {
      return queue.flush();
    },

    async close() {
      const results = await queue.close();
      listeners.clear();
      return results;
    },
  };
}
