// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the privacy surface is intentionally aggregated here
export {
  deriveAppIdentityKek,
  generateAppIdentityKey,
  INITIAL_APP_IDENTITY_KEY_VERSION,
  isAppIdentityKeyVersion,
  nextAppIdentityVersion,
  unwrapAppIdentityKey,
  wrapAppIdentityKey,
} from "./app-identity-key";
export type { WrappedAppIdentityKey } from "./app-identity-key";
export {
  advanceAppIdentityEpoch,
  APP_IDENTITY_RECORD_SCHEMA_VERSION,
  defaultAppEntityIdentityRecordKey,
  makeKvAppIdentityStore,
  makeMemoryAppIdentityStore,
  mintInitialAppIdentityRecord,
  parseWrappedAppIdentityRecord,
  rewrapKvAppIdentityRecord,
  unwrapAppIdentityRecord,
  wrapAppIdentityRecord,
} from "./app-identity-store";
export type {
  AppIdentityEpoch,
  AppIdentityKv,
  AppIdentityRecord,
  AppIdentitySaveOptions,
  AppIdentityStore,
  WrappedAppIdentityEpoch,
  WrappedAppIdentityRecord,
} from "./app-identity-store";
export {
  DEFAULT_PRIVACY_KEY_VERSION,
  HISTORICAL_SHARED_ROOT_KEY_VERSIONS,
  isHistoricalSharedRootKeyVersion,
  LOCAL_PRIVACY_SALT_FIXTURE,
  makeDerivedSaltStore,
  makeIdentitySaltStore,
  resolvePrivacyRootSecret,
} from "./derived-salt-store";
export type { DerivedSaltStoreOptions, IdentitySaltStoreOptions } from "./derived-salt-store";
export {
  analysisRowsForEntity,
  canonicalizeAnalysisEntityHash,
  computeRetainedTargetingKeyHashes,
  resolveEntityPrivacyIdentity,
} from "./entity-privacy";
export type { EntityPrivacyIdentity, EntityPrivacyInput } from "./entity-privacy";
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
