export type { AppIdentityKv } from "./app-identity-exclusive";
// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the privacy surface is intentionally aggregated here
export { putWrappedAppIdentityIfAbsent } from "./app-identity-exclusive";
export type { WrappedAppIdentityKey } from "./app-identity-key";
export {
  deriveAppIdentityKek,
  generateAppIdentityKey,
  INITIAL_APP_IDENTITY_KEY_VERSION,
  isAppIdentityKeyVersion,
  nextAppIdentityVersion,
  unwrapAppIdentityKey,
  wrapAppIdentityKey,
} from "./app-identity-key";
export type {
  AppIdentityEpoch,
  AppIdentityRecord,
  WrappedAppIdentityEpoch,
  WrappedAppIdentityRecord,
} from "./app-identity-record";
export {
  APP_IDENTITY_RECORD_SCHEMA_VERSION,
  defaultAppEntityIdentityRecordKey,
  parseWrappedAppIdentityRecord,
  unwrapAppIdentityRecord,
  wrapAppIdentityRecord,
} from "./app-identity-record";
export type {
  AppIdentityResetPurger,
  AppIdentityResetPurgers,
  AppIdentityResetReleasers,
} from "./app-identity-reset";
export {
  APP_IDENTITY_RESET_SUBJECT_REF,
  resetCompromisedAppIdentity,
} from "./app-identity-reset";
export type {
  AppIdentityLifecycle,
  AppIdentityResetProofs,
  AppIdentityResetRelease,
  AppIdentityResetReleaseProofs,
  AppIdentityResetStore,
} from "./app-identity-lifecycle";
export {
  APP_IDENTITY_RESET_RELEASES,
  APP_IDENTITY_RESET_STORES,
  assertAppIdentityTrafficAllowed,
} from "./app-identity-lifecycle";
export type {
  AppIdentityCoordinatorNamespace,
  AppIdentityStore,
} from "./app-identity-store";
export {
  makeDurableAppIdentityStore,
  makeKvAppIdentityStore,
  makeMemoryAppIdentityStore,
  mintInitialAppIdentityRecord,
  requireAppIdentityRecord,
  rewrapKvAppIdentityRecord,
} from "./app-identity-store";
export type { DerivedSaltStoreOptions, IdentitySaltStoreOptions } from "./derived-salt-store";
export {
  DEFAULT_PRIVACY_KEY_VERSION,
  HISTORICAL_SHARED_ROOT_KEY_VERSIONS,
  isHistoricalSharedRootKeyVersion,
  LOCAL_PRIVACY_SALT_FIXTURE,
  makeDerivedSaltStore,
  makeIdentitySaltStore,
  resolvePrivacyRootSecret,
} from "./derived-salt-store";
export type { EntityPrivacyIdentity, EntityPrivacyInput } from "./entity-privacy";
export {
  analysisRowsForEntity,
  canonicalizeAnalysisEntityHash,
  canonicalizeAnalysisRows,
  canonicalizeSharedRootTargetingKeyHash,
  computeEntityFamilyHash,
  computeRetainedTargetingKeyHashes,
  entityFamilyHash,
  joinMetricEventsToExposures,
  resolveEntityPrivacyIdentity,
} from "./entity-privacy";
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
