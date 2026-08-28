// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the privacy surface is intentionally aggregated here
export { deriveAppPrivacySalt } from "./derive-app-salt";
export {
  EVALUATION_IDENTITY_EPOCH,
  HISTORICAL_SHARED_ROOT_KEY_VERSIONS,
  INGEST_IDENTITY_EPOCH,
  isHistoricalSharedRootKeyVersion,
  LEFTOVER_APP_DERIVED_KEY_VERSION,
  LOCAL_PRIVACY_SALT_FIXTURE,
  makeMemoryIdentitySaltStore,
  makePersistedIdentitySaltStore,
  resolvePrivacyRootSecret,
} from "./derived-salt-store";
export type { IdentitySaltStore, PersistedIdentitySaltStoreOptions } from "./derived-salt-store";
export type { TargetingKeyHashInput } from "./hash";
export {
  computeTargetingKeyHash,
  hashTargetingKeyWithMaterial,
  keyVersionOf,
  targetingKeyHashesForLookup,
} from "./hash";
export type {
  IdentityKeyKv,
  IdentityKeyPersist,
  LoadedAppIdentityKey,
} from "./identity-key-persist";
export {
  loadOrBootstrapAppIdentityKey,
  makeKvIdentityKeyPersist,
  makeMemoryIdentityKeyPersist,
  mintAppIdentityEpoch,
  rewrapAppIdentityKey,
} from "./identity-key-persist";
export { isContainerKey, isLeafPiiKey, isPiiKey, REDACTED } from "./redaction-rules";
export type { KeyVersion, SaltStore } from "./salt-store";
export type { ScrubOptions } from "./scrubber";
export { scrubValue } from "./scrubber";
export type { SentryEventLike } from "./sentry-scrubber";
export { scrubSentryEvent, scrubSentrySpan, scrubSentryTransaction } from "./sentry-scrubber";
export type { ValuePatternOptions } from "./value-patterns";
export { redactValuePatterns } from "./value-patterns";
export type { AppIdentityKeyRecord } from "./wrap-identity-key";
export {
  IDENTITY_KEY_WRAP_IV_BYTES,
  IDENTITY_KEY_WRAP_SCHEMA_VERSION,
  parseAppIdentityKeyRecord,
  unwrapIdentityKey,
  wrapIdentityKey,
} from "./wrap-identity-key";
