import { SplitchSdkError } from "../errors";
import type { EvaluateContext, Logger } from "../evaluate";
import { sdkErrorForFailure } from "../evaluate";
import type { PrecomputedEvaluations } from "../evaluate-all";
import type {
  EvaluateAllEntry,
  ExposureBatchResult,
  VariantValue,
} from "../generated/contract-surface.js";
import type { SdkResolutionDetails } from "../resolution";
import {
  logListenerFailures,
  loudly,
  mintIdempotencyKey,
  resolveBootstrap,
  resolveBrowserClientKey,
  resolveContext,
  resolveRevalidateMs,
} from "./client-helpers";
import { decorateHeldDetails, registerBrowserClientInternalAccess } from "./client-internals";
import { ExposureQueue } from "./exposure-queue";
import { deriveHeldResolution, logHeldResolution } from "./held-resolution";
import { BrowserPayloadStore, type HeldPayload } from "./payload-store";
import { RevalidationLoop } from "./revalidation-loop";
import { type BrowserTransport, createBrowserFetchTransport } from "./transport";

const DEFAULT_ENDPOINT = "https://edge.splitch.dev";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_REVALIDATE_MS = 60_000;
const FALLBACK_DEFAULT_VALUE: VariantValue = false;

/**
 * Options for {@link createSplitchBrowserClient}. Client Key only; one Evaluation
 * Context for the client's lifetime. Construction performs no I/O.
 *
 */
export interface SplitchBrowserClientOptions {
  /** Public Client Key (`pk_…`). A secret `sk_`/`ak_` value throws at construction. */
  readonly clientKey: string;
  /** One Evaluation Context for the client's lifetime (static-context paradigm). */
  readonly context: EvaluateContext;
  /**
   * Server-produced `evaluateAll` payload for synchronous SSR hydration. Its
   * context must canonically equal {@link context} or construction throws
   * `SDK_BOOTSTRAP_CONTEXT_MISMATCH`.
   */
  readonly bootstrap?: PrecomputedEvaluations | null;
  /** ETag revalidation interval in milliseconds. Defaults to 60,000; 0 disables it. */
  readonly revalidateMs?: number;
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
  /** Fetch Precomputed Evaluations once; no network call when bootstrapped. */
  init(): Promise<void>;
  /** Synchronous exposing read of the held Variant value. */
  evaluate(flagKey: string, defaultValue?: VariantValue): VariantValue;
  /** Synchronous exposing read returning full ResolutionDetails. */
  evaluateDetails(flagKey: string, defaultValue?: VariantValue): SdkResolutionDetails;
  /** Subscribe to swaps that change this Flag's resolution. Subscribing is non-exposing. */
  subscribe(flagKey: string, listener: () => void): () => void;
  /** Acknowledged Exposure queue flush; resolves with per-item results. */
  flush(): Promise<readonly ExposureBatchResult[]>;
  /** Final flush; stops timers and page-lifecycle listeners. */
  close(): Promise<readonly ExposureBatchResult[]>;
}

/**
 * Create the static-context browser client. With `bootstrap`, reads are
 * synchronous immediately and `init()` performs no fetch. Without it, await
 * `init()` before the first read. Revalidation uses the held ETag and keeps
 * serving last-known-good values through observable failures.
 *
 * @see https://splitch.dev/docs/sdk/install
 */
export function createSplitchBrowserClient(
  options: SplitchBrowserClientOptions,
): SplitchBrowserClient {
  const clientKey = resolveBrowserClientKey(options.clientKey);
  const context = resolveContext(options.context);
  const { targetingKey } = context;
  const revalidateMs = resolveRevalidateMs(options.revalidateMs, DEFAULT_REVALIDATE_MS);
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const initial = initialPayload(options.bootstrap, context);
  const transport =
    options.transport ??
    createBrowserFetchTransport({
      credential: clientKey,
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: options.fetch ?? globalThis.fetch.bind(globalThis),
    });

  let initPromise: Promise<void> | null = null;
  const loggedMissing = new Set<string>();
  const store = new BrowserPayloadStore(initial);
  // Pass document/window only when the key is present: an absent key means
  // "use the ambient global", while explicit undefined/null means "absent".
  const queue = new ExposureQueue({
    transport,
    logger,
    now,
    ...("document" in options ? { document: options.document } : {}),
    ...("window" in options ? { window: options.window } : {}),
  });

  const revalidation = new RevalidationLoop({
    transport,
    logger,
    context,
    intervalMs: revalidateMs,
    getEtag: () => requireHeld().etag,
    onPayload: (evaluations, etag) => {
      const changed = store.swap({ evaluations, etag });
      queue.rearm(changed);
      logListenerFailures(logger, store.notify(changed));
    },
    onNotModified: () => store.markRecovered(),
    onFailure: () => store.markDegraded(),
  });

  function requireHeld(): HeldPayload {
    const held = store.current();
    if (held === null) {
      throw new SplitchSdkError({
        code: "SDK_NOT_INITIALIZED",
        causeSummary: "A Flag was read before init() resolved",
        remediation: "Await init() before evaluate/evaluateDetails",
      });
    }
    return held;
  }

  function readHeldEntry(flagKey: string) {
    const payload = requireHeld();
    return Object.hasOwn(payload.evaluations, flagKey) ? payload.evaluations[flagKey] : undefined;
  }

  function deriveDetails(
    flagKey: string,
    entry: ReturnType<typeof readHeldEntry>,
    defaultValue: VariantValue,
  ) {
    const resolution = deriveHeldResolution(flagKey, entry, defaultValue);
    logHeldResolution(flagKey, resolution, targetingKey, logger, loggedMissing);
    return resolution;
  }

  function readDetails(flagKey: string, defaultValue: VariantValue): SdkResolutionDetails {
    const entry = readHeldEntry(flagKey);
    const resolution = deriveDetails(flagKey, entry, defaultValue);
    if (resolution.kind !== "entry") {
      return resolution.details;
    }
    const { exposureTicket } = entry as EvaluateAllEntry;
    if (exposureTicket !== null) {
      queue.enqueue(flagKey, exposureTicket);
    }
    return decorateHeldDetails(
      resolution.details.value,
      resolution.details.variantName,
      resolution.details.reason,
      store.isDegraded(),
    );
  }

  const client: SplitchBrowserClient = {
    async init() {
      if (store.current() !== null) {
        revalidation.start();
        return;
      }
      // After success initPromise stays set, so concurrent/repeat callers await
      // the same promise (or return immediately once settled). Cleared only on failure.
      if (initPromise !== null) {
        return initPromise;
      }
      initPromise = (async () => {
        const idempotencyKey = mintIdempotencyKey(logger, targetingKey);
        const result = await transport.evaluateAll({
          targetingKey,
          idType: context.idType,
          attributes: context.attributes,
          idempotencyKey,
        });
        if (result.status !== 200 || result.evaluations === null || result.etag === null) {
          throw loudly(
            logger,
            targetingKey,
            sdkErrorForFailure("evaluateAll", result),
            result.cause,
          );
        }
        store.setInitial({ evaluations: result.evaluations, etag: result.etag });
        revalidation.start();
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
      return store.subscribe(flagKey, listener);
    },

    async flush() {
      return queue.flush();
    },

    async close() {
      revalidation.stop();
      return queue.close();
    },
  };
  registerBrowserClientInternalAccess(client, {
    readRevalidationDegraded: () => store.isDegraded(),
    readHeldEntry,
    deriveHeldResolution: deriveDetails,
  });

  if (initial !== null) {
    revalidation.start();
  }
  return client;
}

function initialPayload(
  bootstrap: PrecomputedEvaluations | null | undefined,
  context: ReturnType<typeof resolveContext>,
): HeldPayload | null {
  return bootstrap === undefined || bootstrap === null
    ? null
    : resolveBootstrap(bootstrap, context);
}
