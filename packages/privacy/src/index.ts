// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the privacy surface is intentionally aggregated here
export { computeTargetingKeyHash, keyVersionOf } from "./hash.js";
export type { TargetingKeyHashInput } from "./hash.js";
export type { KeyVersion, SaltStore } from "./salt-store.js";
export { isContainerKey, isLeafPiiKey, isPiiKey, REDACTED } from "./redaction-rules.js";
export { redactValuePatterns } from "./value-patterns.js";
export type { ValuePatternOptions } from "./value-patterns.js";
export { scrubValue } from "./scrubber.js";
export type { ScrubOptions } from "./scrubber.js";
export { scrubSentryEvent } from "./sentry-scrubber.js";
export type { SentryEventLike } from "./sentry-scrubber.js";
