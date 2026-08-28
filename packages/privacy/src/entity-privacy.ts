/**
 * Retained-epoch Targeting Key hash resolution for export, deletion, retry,
 * and analysis joins. Raw Targeting Keys stay in memory for HMAC derivation
 * only and are never returned as durable identifiers.
 */

import { isAppIdentityKeyVersion } from "./app-identity-key";
import { HISTORICAL_SHARED_ROOT_KEY_VERSIONS } from "./derived-salt-store-versions";
import { computeTargetingKeyHash, keyVersionOf } from "./hash";
import { hmacSha256Hex } from "./hmac";
import type { SaltStore } from "./salt-store";

export interface EntityPrivacyInput {
  appId: string;
  idType: string;
  targetingKey: string;
}

export interface EntityPrivacyIdentity {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  entityFamilyHash: string;
}

/**
 * Every retained `targeting_key_hash` for this Entity, historical epochs first
 * and the current write epoch last when it has been minted.
 */
export async function computeRetainedTargetingKeyHashes(
  store: SaltStore,
  input: EntityPrivacyInput,
): Promise<readonly string[]> {
  const versions = await store.retainedKeyVersions(input.appId);
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const keyVersion of versions) {
    const salts = store.saltsFor
      ? await store.saltsFor(input.appId, keyVersion)
      : [await store.saltFor(input.appId, keyVersion)];
    for (const salt of salts) {
      const hash = await computeTargetingKeyHash(store, { ...input, keyVersion, salt });
      if (!seen.has(hash)) {
        seen.add(hash);
        hashes.push(hash);
      }
    }
  }
  return hashes;
}

export async function resolveEntityPrivacyIdentity(
  store: SaltStore,
  input: EntityPrivacyInput,
): Promise<EntityPrivacyIdentity> {
  const targetingKeyHashes = await computeRetainedTargetingKeyHashes(store, input);
  return {
    appId: input.appId,
    idType: input.idType,
    targetingKeyHashes,
    entityFamilyHash: await entityFamilyHashForRetained(store, input, targetingKeyHashes),
  };
}

/**
 * App-scoped join key shared by every retained physical hash for one Entity.
 * The oldest retained App-specific epoch remains the family anchor while any
 * rows from that epoch exist. A destructive reset purges those rows before the
 * epoch is removed, so the replacement App identity starts a new family.
 */
export function entityFamilyHash(
  _appId: string,
  _idType: string,
  retainedHashes: readonly string[],
): string {
  const anchor = retainedHashes.find((hash) => isAppIdentityKeyVersion(keyVersionOf(hash)));
  if (anchor === undefined) {
    throw new Error("privacy: no App-scoped targeting_key_hash for Entity family");
  }
  return anchor;
}

export async function computeEntityFamilyHash(
  store: SaltStore,
  input: EntityPrivacyInput,
): Promise<string> {
  return entityFamilyHashForRetained(
    store,
    input,
    await computeRetainedTargetingKeyHashes(store, input),
  );
}

async function entityFamilyHashForRetained(
  store: SaltStore,
  input: EntityPrivacyInput,
  retainedHashes: readonly string[],
): Promise<string> {
  const appAnchor = retainedHashes.find((hash) => isAppIdentityKeyVersion(keyVersionOf(hash)));
  if (appAnchor !== undefined) return appAnchor;
  const compatibilityAnchor = retainedHashes[0];
  if (compatibilityAnchor === undefined) {
    throw new Error("privacy: no retained targeting_key_hash for Entity family");
  }
  const version = keyVersionOf(compatibilityAnchor);
  const salt = await store.saltFor(input.appId, version);
  const digest = await hmacSha256Hex(
    salt,
    `entity-family:${input.appId}:${input.idType}:${input.targetingKey}`,
  );
  return `${version}:${digest}`;
}

/** Current-epoch hash when present; otherwise the newest retained hash. */
export function canonicalizeAnalysisEntityHash(retainedHashes: readonly string[]): string {
  const current = retainedHashes[retainedHashes.length - 1];
  if (current === undefined) {
    throw new Error("privacy: no retained targeting_key_hash for analysis join");
  }
  return current;
}

export function analysisRowsForEntity<T extends { targeting_key_hash: string }>(
  rows: readonly T[],
  retainedHashes: readonly string[],
): T[] {
  const hashes = new Set(retainedHashes);
  return rows.filter((row) => hashes.has(row.targeting_key_hash));
}

/**
 * Join one Entity's Exposures to its Metric Events across every retained
 * identity epoch. Rows whose hash is not in this Entity's canonical set are
 * dropped, so a second App cannot contribute.
 */
export function joinMetricEventsToExposures<
  Exposure extends { targeting_key_hash: string },
  MetricEvent extends { targeting_key_hash: string },
>(
  exposures: readonly Exposure[],
  metricEvents: readonly MetricEvent[],
  retainedHashes: readonly string[],
): { exposures: Exposure[]; metricEvents: MetricEvent[] } {
  if (retainedHashes.length === 0) {
    throw new Error("privacy: no retained targeting_key_hash for analysis join");
  }
  return {
    exposures: analysisRowsForEntity(exposures, retainedHashes),
    metricEvents: analysisRowsForEntity(metricEvents, retainedHashes),
  };
}

/**
 * Historical Evaluation (`local-v1:`) and Metric Event (`v1:`) hashes share one
 * digest under the pinned shared-root key. Analysis joins them as one Entity.
 */
export function canonicalizeSharedRootTargetingKeyHash(hash: string): string {
  if (!hash.includes(":")) return hash;
  const version = keyVersionOf(hash);
  if (version === HISTORICAL_SHARED_ROOT_KEY_VERSIONS[0]) {
    return `${HISTORICAL_SHARED_ROOT_KEY_VERSIONS[1]}:${hash.slice(version.length + 1)}`;
  }
  return hash;
}

export function canonicalizeAnalysisRows<T extends { targeting_key_hash?: unknown }>(
  rows: readonly T[],
  retainedGroups: readonly (readonly string[])[] = [],
): T[] {
  const alias = new Map<string, string>();
  for (const group of retainedGroups) {
    if (group.length === 0) continue;
    const canonical = canonicalizeAnalysisEntityHash(group);
    for (const hash of group) {
      alias.set(hash, canonical);
    }
  }
  return rows.map((row) => {
    if (typeof row.targeting_key_hash !== "string" || !row.targeting_key_hash.includes(":")) {
      return row;
    }
    const grouped = alias.get(row.targeting_key_hash);
    const hash = grouped ?? canonicalizeSharedRootTargetingKeyHash(row.targeting_key_hash);
    return hash === row.targeting_key_hash ? row : { ...row, targeting_key_hash: hash };
  });
}
