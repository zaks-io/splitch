// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the privacy surface is intentionally aggregated here
export { deriveAppPrivacySalt } from "./derive-app-salt";
export {
  DEFAULT_PRIVACY_KEY_VERSION,
  LOCAL_PRIVACY_SALT_FIXTURE,
  makeDerivedSaltStore,
  resolvePrivacyRootSecret,
} from "./derived-salt-store";
export type { TargetingKeyHashInput } from "./hash";
export { computeTargetingKeyHash, keyVersionOf } from "./hash";
export { isContainerKey, isLeafPiiKey, isPiiKey, REDACTED } from "./redaction-rules";
export type { KeyVersion, SaltStore } from "./salt-store";
export type { ScrubOptions } from "./scrubber";
export { scrubValue } from "./scrubber";
export type { SentryEventLike } from "./sentry-scrubber";
export { scrubSentryEvent, scrubSentrySpan, scrubSentryTransaction } from "./sentry-scrubber";
export type { ValuePatternOptions } from "./value-patterns";
export { redactValuePatterns } from "./value-patterns";
