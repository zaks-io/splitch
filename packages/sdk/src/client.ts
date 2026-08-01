import type { EvaluateContext, EvaluateDeps, EvaluationContext, Logger } from "./evaluate";
import { runEvaluate, runPeekVariant, runVerify } from "./evaluate";
import { SplitchSdkError } from "./errors";
import { createFetchTransport } from "./fetch-transport";
import type { ResolutionDetails, VariantValue } from "./generated/contract-surface.js";
import { SeenSet } from "./seen-set";
import type { Transport } from "./transport";

/**
 * Options for {@link createSplitchClient}. Exactly one credential is required:
 * a public `clientKey` (safe to embed in browsers and mobile apps) or a secret
 * `apiKey` (servers only; never ship it to a client). Construction performs no
 * I/O; each evaluation is a single request to the splitch edge.
 *
 * `transport`, `logger`, `fetch`, and `now` are injectable seams so the client
 * is fully testable without a network or a real clock.
 */
export interface SplitchClientOptions {
  /** Public Client Key (`ck_...`). Mutually exclusive with `apiKey`. */
  readonly clientKey?: string;
  /** Secret API Key (`sk_...`), servers only. Mutually exclusive with `clientKey`. */
  readonly apiKey?: string;
  /** Override the default edge endpoint for self-hosted or preview targets. */
  readonly endpoint?: string;
  /** Per-call request timeout in ms (default 5000); on timeout the SDK fails loud (reason: ERROR). */
  readonly timeoutMs?: number;
  /** Retries on the Exposure-bearing call. MUST be 0: a retry is a fresh resolution. */
  readonly retries?: number;
  /** Custom network adapter; defaults to the built-in `fetch` HTTP adapter. */
  readonly transport?: Transport;
  /** Receives every fail-loud report; defaults to `console`. */
  readonly logger?: Logger;
  /** Max entries in the local Exposure-dedup cache. */
  readonly seenSetMaxSize?: number;
  /** Exposure-dedup revalidation window; a new Run is detected within this many ms. */
  readonly revalidateMs?: number;
  /** Injectable `fetch` implementation (defaults to the global). */
  readonly fetch?: typeof fetch;
  /** Injectable epoch-ms clock (defaults to `Date.now`). */
  readonly now?: () => number;
}

export interface SplitchClient {
  /**
   * Resolve a Flag and return the unwrapped Variant value. Fires an Exposure
   * (the event experiment analysis counts), deduplicated locally per Flag and
   * targeting key within the revalidation window.
   *
   * Never throws and never retries: on any failure it returns
   * `context.defaultValue` (or `false`) and logs loudly. Use
   * {@link SplitchClient.evaluateDetails} to branch on `reason: "ERROR"`.
   *
   * @example
   * const variant = await splitch.evaluate("new-checkout", {
   *   targetingKey: user.id,
   *   // Stable per logical evaluation; reuse it when retrying an uncertain request.
   *   idempotencyKey: crypto.randomUUID(),
   *   defaultValue: false,
   * });
   */
  evaluate(flagKey: string, context: EvaluationContext): Promise<VariantValue>;
  /** Resolve a Flag and return the full OpenFeature ResolutionDetails. Fires an Exposure. */
  evaluateDetails(flagKey: string, context: EvaluationContext): Promise<ResolutionDetails>;
  /**
   * Resolve a Flag without firing an Exposure, for inspecting a resolution
   * outside the real user path. API Key only; throws `SplitchSdkError`
   * (fields `code`, `status`) on any failure.
   */
  peekVariant(flagKey: string, context: EvaluateContext): Promise<VariantValue>;
  /**
   * Confirm setup end to end without firing an Exposure: same response shape
   * as `evaluateDetails`, safe to call repeatedly. Client Key or API Key.
   */
  verify(flagKey: string, context: EvaluateContext): Promise<ResolutionDetails>;
}

const DEFAULT_ENDPOINT = "https://edge.splitch.dev";
/**
 * Covers a cold call, not a warm one. `retries` is structurally 0 (an
 * Exposure-bearing call must not be repeated), so a timeout is terminal: it
 * spends the caller's Exposure and returns the Default Variant. At the former
 * 1000ms a first evaluation against healthy production measured 1935ms and
 * aborted, which made a new integrator's very first Exposure fail by default.
 * A caller who wants a tighter latency budget can still set `timeoutMs` down.
 */
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 0;

/**
 * Create a splitch client. Pass exactly one credential: `clientKey` (public,
 * browser/mobile) or `apiKey` (secret, server only). Construction performs no
 * I/O; the first evaluation reaches the splitch edge.
 *
 * @example
 * import { createSplitchClient } from "@splitch/sdk";
 *
 * const splitch = createSplitchClient({ clientKey: "ck_live_..." });
 * const variant = await splitch.evaluate("new-checkout", {
 *   targetingKey: user.id,
 *   idempotencyKey: crypto.randomUUID(),
 * });
 *
 * @see https://splitch.dev/quickstart
 */
export function createSplitchClient(options: SplitchClientOptions): SplitchClient {
  const credential = resolveCredential(options);
  if (options.retries !== undefined && options.retries !== DEFAULT_RETRIES) {
    // Fail loud: silently retrying an Exposure-bearing call would double-count.
    throw new SplitchSdkError({
      code: "SDK_RETRIES_INVALID",
      causeSummary: "Exposure-bearing evaluations require retries to be 0",
      remediation: "Remove the retries option or set it to 0",
    });
  }

  const deps: EvaluateDeps = {
    transport:
      options.transport ??
      createFetchTransport({
        credential,
        endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchImpl: options.fetch ?? fetch,
      }),
    seenSet: new SeenSet(options.seenSetMaxSize, options.revalidateMs),
    logger: options.logger ?? console,
    now: options.now ?? Date.now,
  };

  return {
    async evaluate(flagKey, context) {
      const details = await runEvaluate(deps, flagKey, context);
      return details.value;
    },
    evaluateDetails(flagKey, context) {
      return runEvaluate(deps, flagKey, context);
    },
    peekVariant(flagKey, context) {
      return runPeekVariant(deps, flagKey, context);
    },
    verify(flagKey, context) {
      return runVerify(deps, flagKey, context);
    },
  };
}

function resolveCredential(options: SplitchClientOptions): string {
  const hasClient = typeof options.clientKey === "string" && options.clientKey.length > 0;
  const hasApi = typeof options.apiKey === "string" && options.apiKey.length > 0;
  if (hasClient === hasApi) {
    // Exactly one credential; presenting both or neither is a setup bug.
    throw new SplitchSdkError({
      code: "SDK_CREDENTIAL_CONFIGURATION_INVALID",
      causeSummary: "The SDK requires exactly one of clientKey or apiKey",
      remediation: "Provide one credential and remove the other credential option",
    });
  }
  return (options.clientKey ?? options.apiKey) as string;
}
