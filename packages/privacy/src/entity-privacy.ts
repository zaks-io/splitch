/**
 * Retained-epoch Targeting Key hash resolution for export, deletion, retry,
 * and analysis joins. Raw Targeting Keys stay in memory for HMAC derivation
 * only and are never returned as durable identifiers.
 */

import { computeTargetingKeyHash } from "./hash";
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
  return {
    appId: input.appId,
    idType: input.idType,
    targetingKeyHashes: await computeRetainedTargetingKeyHashes(store, input),
  };
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
