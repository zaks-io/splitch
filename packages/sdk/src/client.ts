import { requireCredentialPrefix } from "./credential";
import { SplitchSdkError } from "./errors";
import type { EvaluateContext, EvaluateDeps, EvaluationContext, Logger } from "./evaluate";
import { runEvaluate, runPeekVariant, runVerify } from "./evaluate";
import type { PrecomputedEvaluations } from "./evaluate-all";
import { runEvaluateAll } from "./evaluate-all";
import { createFetchTransport } from "./fetch-transport";
import type { VariantValue } from "./generated/contract-surface.js";
import type { SdkResolutionDetails } from "./resolution";
import { SeenSet } from "./seen-set";
import type { TrackRequest, TrackResult, Transport } from "./transport";

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
  /** Public Client Key material (`pk_...` from `client-key get`). Mutually exclusive with `apiKey`. */
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
  /**
   * Called with every resolution the user path produced, for observability
   * sinks that want to know which Flags were active. See
   * `@splitch/sdk/sentry` for the Sentry binding.
   *
   * Never called for `peekVariant` or `verify`: those are diagnostics that fire
   * no Exposure, and reporting them would claim a resolution the user never
   * received.
   *
   * Called synchronously and never awaited. A throwing reporter is not caught:
   * an observability sink that fails should fail where it fails, not be
   * swallowed into a silently degraded evaluation.
   */
  readonly onResolution?: (flagKey: string, details: SdkResolutionDetails) => void;
}

export interface SplitchClient {
  /**
   * Append one declared Metric Event and materialize an Activation for every
   * matching live Experiment Run. The caller never supplies Run or Variant ids.
   */
  activate(
    eventName: string,
    event: Omit<TrackRequest, "eventName">,
  ): Promise<{ eventId: string; duplicate: boolean; activatedRuns: number }>;
  /**
   * Append one declared Metric Event. The caller owns the UUID `eventId` and
   * reuses it for retries of the same logical event.
   */
  track(
    eventName: string,
    event: Omit<TrackRequest, "eventName">,
  ): Promise<{
    eventId: string;
    duplicate: boolean;
  }>;
  /**
   * Resolve a Flag and return the unwrapped Variant value. Fires an Exposure
   * (the event experiment analysis counts), deduplicated locally per Flag and
   * targeting key within the revalidation window.
   *
   * Never throws on a runtime failure and never retries: on any platform
   * failure it returns `context.defaultValue` (or `false`) and logs loudly.
   * Use {@link SplitchClient.evaluateDetails} to branch on `reason: "ERROR"`.
   * Throws `SplitchSdkError` if the context omits a required
   * `idempotencyKey` — that is caller misconfiguration, not a runtime
   * failure.
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
  evaluateDetails(flagKey: string, context: EvaluationContext): Promise<SdkResolutionDetails>;
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
  verify(flagKey: string, context: EvaluateContext): Promise<SdkResolutionDetails>;
  /**
   * Resolve every Flag in the credential's App and Environment for one
   * Evaluation Context in a single request, returning the Precomputed
   * Evaluations plus their `ETag`. Fires no Exposure and touches no seen-set:
   * each fresh live-Run assignment carries an Exposure Ticket that a client
   * redeems on first read instead.
   *
   * Serialize the result as-is to hydrate a browser client: it is that client's
   * `bootstrap` input, unmodified. Client Key or API Key; disclosure is
   * identical on both, and the payload carries no rule logic.
   *
   * It does echo the Evaluation Context it was resolved for, `targetingKey` and
   * every attribute included, because the browser client deep-equality-checks
   * that context. Serializing it into a page publishes those attributes, so
   * pass only attributes you would publish.
   *
   * Throws `SplitchSdkError` (fields `code`, `status`) on any failure: there is
   * no partial payload and no default one.
   *
   * @example
   * const precomputed = await splitch.evaluateAll({ targetingKey: user.id });
   * html.embed(JSON.stringify(precomputed));
   */
  evaluateAll(context: EvaluateContext): Promise<PrecomputedEvaluations>;
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
 * // Paste keyMaterial from `splitch client-key get` (pk_…; not the ck_… keyId).
 * const splitch = createSplitchClient({ clientKey: "pk_..." });
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
        // Window.fetch (and similar host objects) must keep their receiver.
        // Storing the unbound global on the transport config and calling it as a
        // method throws "Illegal invocation" in every browser; Node's undici
        // tolerates the unbound call, so Node-only tests cannot catch this.
        fetchImpl: options.fetch ?? globalThis.fetch.bind(globalThis),
      }),
    seenSet: new SeenSet(options.seenSetMaxSize, options.revalidateMs),
    logger: options.logger ?? console,
    now: options.now ?? Date.now,
  };

  return {
    async activate(eventName, event) {
      const result = await deps.transport.activate({ eventName, ...event });
      if (!result.accepted || result.eventId === null) throw metricEventError(result);
      return {
        eventId: result.eventId,
        duplicate: result.duplicate,
        activatedRuns: result.activatedRuns,
      };
    },
    async track(eventName, event) {
      const result = await deps.transport.track({ eventName, ...event });
      if (!result.accepted || result.eventId === null) {
        throw metricEventError(result);
      }
      return {
        eventId: result.eventId,
        duplicate: result.duplicate,
      };
    },
    async evaluate(flagKey, context) {
      const details = await report(flagKey, await runEvaluate(deps, flagKey, context));
      return details.value;
    },
    async evaluateDetails(flagKey, context) {
      return report(flagKey, await runEvaluate(deps, flagKey, context));
    },
    peekVariant(flagKey, context) {
      return runPeekVariant(deps, flagKey, context);
    },
    verify(flagKey, context) {
      return runVerify(deps, flagKey, context);
    },
    async evaluateAll(context) {
      const precomputed = await runEvaluateAll(deps, context);
      reportPrecomputed(options.onResolution, precomputed);
      return precomputed;
    },
  };

  function report(flagKey: string, details: SdkResolutionDetails): SdkResolutionDetails {
    options.onResolution?.(flagKey, details);
    return details;
  }
}

function metricEventError(result: TrackResult): SplitchSdkError {
  return new SplitchSdkError({
    code: result.errorCode ?? "SDK_TRANSPORT_PARSE",
    causeSummary: result.errorMessage ?? "Metric Event was rejected",
    remediation: "Correct the Event Definition, identity, or payload and retry",
    status: result.status ?? undefined,
    originalError: result.cause,
  });
}

/**
 * A Precomputed Evaluations entry carries `variant`, not a caller-supplied
 * Default Variant, so an entry that resolved to no arm has no value to report.
 * Reporting one anyway would mean inventing it.
 */
function reportPrecomputed(
  onResolution: SplitchClientOptions["onResolution"],
  precomputed: PrecomputedEvaluations,
): void {
  if (!onResolution) return;
  for (const [flagKey, entry] of Object.entries(precomputed.evaluations)) {
    if (entry.variant === null) continue;
    onResolution(flagKey, {
      value: entry.variant,
      variantName: entry.variantName,
      reason: entry.reason,
    });
  }
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
  return hasClient
    ? requireCredentialPrefix(options.clientKey as string, "clientKey")
    : requireCredentialPrefix(options.apiKey as string, "apiKey");
}
