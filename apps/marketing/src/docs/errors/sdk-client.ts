import type { ErrorDoc } from "./types";

/**
 * Raised by `@splitch/sdk` itself, before any request goes out. Every one of
 * these is a construction-time misconfiguration: the SDK refuses to start
 * rather than run in a shape that would corrupt Exposure data.
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
    related: ["SERVICE_UNAVAILABLE"],
  },
} satisfies Record<string, ErrorDoc>;
