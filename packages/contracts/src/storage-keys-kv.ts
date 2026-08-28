/**
 * Namespace key-pattern constructors for every KV value blob.
 * Source of truth: docs/spec/contracts/storage-schemas-kv.md (key-pattern table).
 *
 * One builder per documented pattern — string assembly is the single concern
 * here, kept apart from the Zod value schemas (storage-schemas-kv.ts). Centralizing
 * the patterns means a key-shape change has exactly ONE authoring point and the
 * edge never hand-concatenates a key that could drift from the writer.
 *
 * NOTE on the assignment key: it is per-Entity and deliberately OMITS
 * `environmentId` — `experimentId` already implies its Environment, and one read
 * must return every Experiment's holdover for the Entity (ADR-0008/0009). The
 * config keys, by contrast, are per-Environment (ADR-0027) and carry it.
 */

/** `app:{appId}:{environmentId}:flag:{flagKey}` — hot-path FlagConfigKV read. */
export function flagConfigKey(appId: string, environmentId: string, flagKey: string): string {
  return `app:${appId}:${environmentId}:flag:${flagKey}`;
}

/** `app:{appId}:{environmentId}:run:{runId}` — hot-path RunConfigKV read. */
export function runConfigKey(appId: string, environmentId: string, runId: string): string {
  return `app:${appId}:${environmentId}:run:${runId}`;
}

/**
 * `app:{appId}:{environmentId}:experiment:{experimentId}` — ExperimentConfigKV
 * read. Per-Environment (ADR-0027), mirroring the flag/run key shape; the edge
 * evaluate path reads it to learn the Experiment's `targetingKey`, the id_type
 * stamped on the Exposure, and the live Run pointer.
 */
export function experimentConfigKey(
  appId: string,
  environmentId: string,
  experimentId: string,
): string {
  return `app:${appId}:${environmentId}:experiment:${experimentId}`;
}

/** App-level published Event Definition resolved by name during Metric Event ingest. */
export function eventDefinitionConfigKey(appId: string, eventName: string): string {
  return `app:${appId}:event-definition:${eventName}`;
}

/** `live_run:{appId}:{environmentId}:{experimentId}` — explicit live Experiment Run pointer. */
export function liveRunKey(appId: string, environmentId: string, experimentId: string): string {
  return `live_run:${appId}:${environmentId}:${experimentId}`;
}

/**
 * Credential validation cache keys (CredentialCacheKV value, short TTL). Client
 * Keys and API Keys cache under distinct prefixes so the kind is unambiguous at
 * the key level, not only in the value (credentials-and-keys.md).
 *
 * `ck:{keyMaterialHash}` — Client Key (public) cache entry.
 */
export function clientKeyCacheKey(keyMaterialHash: string): string {
  return `ck:${keyMaterialHash}`;
}

/** `ak:{keyHash}` — API Key (secret) cache entry. */
export function apiKeyCacheKey(keyHash: string): string {
  return `ak:${keyHash}`;
}

export const TERMINAL_CREDENTIAL_REVOCATION_MARKER = "1";

/** Terminal marker that takes precedence over a mutable credential cache entry. */
export function credentialRevocationCacheKey(credentialCacheKey: string): string {
  return `revoked:${credentialCacheKey}`;
}

/**
 * `member-profile:{userId}` — SESSION_STORE identity cache for Org member email.
 * Written at login (auth-api / Control Panel); read by control-plane member
 * endpoints. Email is never stored in D1 (organization-and-membership.md).
 */
export function memberProfileCacheKey(userId: string): string {
  return `member-profile:${userId}`;
}

/**
 * `assignment:{appId}:{idType}:{targetingKeyHash}` — Assignment Store per-Entity
 * read key. NO `environmentId`: experimentId (inside the value) implies the
 * Environment, and the read must return holdovers across every Experiment in one
 * round-trip. `targetingKeyHash` is the HMAC of the raw Targeting Key; the raw
 * value never appears in a key name (privacy lifecycle).
 */
export function assignmentKey(appId: string, idType: string, targetingKeyHash: string): string {
  return `assignment:${appId}:${idType}:${targetingKeyHash}`;
}

/**
 * `app:{appId}:entity-identity` — wrapped App `app_entity_identity_key` epochs
 * (ADR-0044). Lives in the App-scoped Config Store Durable Object. The raw
 * Targeting Key is never stored.
 */
export function appEntityIdentityKey(appId: string): string {
  return `app:${appId}:entity-identity`;
}
