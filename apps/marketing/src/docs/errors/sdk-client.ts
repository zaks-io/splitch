import type { ErrorDoc } from "./types";

/**
 * Raised by `@splitch/sdk` itself. Construction-time misconfiguration refuses
 * to start; transport codes are runtime failures that never left the client
 * process (distinct from the server's `SERVICE_UNAVAILABLE`).
 */
export const sdkErrorDocs = {
  SDK_CREDENTIAL_CONFIGURATION_INVALID: {
    cause: "`createSplitchClient` was given no credential, or both a `clientKey` and an `apiKey`.",
    fix: "Pass exactly one. Use `clientKey` (the `pk_…` key material from `splitch client-key get`) for anything that evaluates, including servers. Use `apiKey` (`sk_…`, servers only) for `peekVariant`. The two unlock different methods, so the client cannot pick for you.",
    related: ["UNAUTHORIZED", "INSUFFICIENT_SCOPES"],
  },
  SDK_RETRIES_INVALID: {
    cause: "`retries` was set to anything other than `0`.",
    fix: "Leave `retries` at `0`. A retry is a fresh resolution and would record a second Exposure for one logical evaluation, double-counting the subject. To make an uncertain call safe to repeat, resend it with the same `idempotencyKey` instead.",
    related: ["SDK_CACHED_TELEMETRY_FAILED"],
  },
  SDK_SEEN_SET_MAX_SIZE_INVALID: {
    cause: "The seen-set `maxSize` is not a positive integer.",
    fix: "Pass a positive integer, or omit it for the default. The seen set is what suppresses duplicate Exposures within the revalidation window; a zero or negative bound would disable dedup silently.",
    related: ["SDK_SEEN_SET_TTL_INVALID"],
  },
  SDK_SEEN_SET_TTL_INVALID: {
    cause: "The seen-set TTL is not a positive duration.",
    fix: "Pass a positive number of milliseconds, or omit it for the default.",
    related: ["SDK_SEEN_SET_MAX_SIZE_INVALID"],
  },
  SDK_CACHED_TELEMETRY_FAILED: {
    cause: "A cached-evaluation telemetry report could not be delivered.",
    fix: "This concerns telemetry for a replayed local resolution, not the resolution itself: the value your code received is unaffected. Check network reachability to the endpoint if it repeats. It is reported rather than dropped so a silent telemetry gap never looks like an absence of traffic.",
    related: ["SERVICE_UNAVAILABLE", "SDK_TRANSPORT_NETWORK"],
  },
  SDK_IDEMPOTENCY_KEY_UNAVAILABLE: {
    cause:
      "`evaluateAll` was called without an `idempotencyKey` in a runtime where `crypto.randomUUID` does not exist. It is secure-context-only, so a page served over plain `http://` reaches this.",
    fix: "Pass your own `idempotencyKey` on the context, or serve the page from a secure context (`https://` or `localhost`). The SDK refuses to substitute a weaker random source: this key is the batch's billing replay identity, and a colliding one would let a repeated fetch be charged twice.",
    related: ["SDK_RETRIES_INVALID"],
  },
  SDK_TRANSPORT_NETWORK: {
    cause:
      "The SDK's transport threw before receiving an HTTP response — for example a network failure, a cancelled request that was not a timeout, or a local `fetch` misconfiguration such as an unbound `Window.fetch`.",
    fix: "Inspect `logger.error`'s `cause` (name, message, stack): the request never left the client. Fix the local fetch/network setup. Do not treat this as a platform outage; `SERVICE_UNAVAILABLE` is reserved for an actual HTTP 503 from the edge.",
    related: ["SDK_TRANSPORT_TIMEOUT", "SDK_TRANSPORT_PARSE", "SERVICE_UNAVAILABLE"],
  },
  SDK_TRANSPORT_TIMEOUT: {
    cause:
      "The per-call request timeout elapsed (or the request was aborted) before a response arrived.",
    fix: "Increase `timeoutMs` if cold starts are expected, or check connectivity. The underlying abort is on `logger.error`'s `cause`. This is not an HTTP 503 from the server.",
    related: ["SDK_TRANSPORT_NETWORK", "SERVICE_UNAVAILABLE"],
  },
  SDK_TRANSPORT_PARSE: {
    cause:
      "The transport received a response body that could not be parsed as the expected evaluate/peek/verify shape.",
    fix: "Confirm the `endpoint` points at a splitch data-plane edge and that intermediaries are not rewriting the body. The parse rejection is on `logger.error`'s `cause`. This is not an HTTP 503 from the server.",
    related: ["SDK_TRANSPORT_NETWORK", "SERVICE_UNAVAILABLE"],
  },
} satisfies Record<string, ErrorDoc>;
