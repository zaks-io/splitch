/**
 * Authenticated Metric Event export/deletion consumers for every retained
 * identity epoch. Control Plane HTTP `entity_privacy_*` stays 503; these
 * library consumers are the lifecycle contract.
 */

import {
  type EntityPrivacyInput,
  resolveEntityPrivacyIdentity,
  type SaltStore,
} from "@splitch/privacy";

export interface EntityMetricRow {
  targeting_key_hash: string;
}

export interface EntityMetricExport<T extends EntityMetricRow> {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  records: readonly T[];
}

export interface EntityMetricDeleteResult {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  deletedCount: number;
}

export async function exportEntityMetricEvents<T extends EntityMetricRow>(
  saltStore: SaltStore,
  input: EntityPrivacyInput,
  rows: readonly T[],
): Promise<EntityMetricExport<T>> {
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  const hashes = new Set(identity.targetingKeyHashes);
  return {
    appId: identity.appId,
    idType: identity.idType,
    targetingKeyHashes: identity.targetingKeyHashes,
    records: rows.filter((row) => hashes.has(row.targeting_key_hash)),
  };
}

export async function deleteEntityMetricEvents<T extends EntityMetricRow>(
  saltStore: SaltStore,
  input: EntityPrivacyInput,
  rows: T[],
): Promise<EntityMetricDeleteResult> {
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  const hashes = new Set(identity.targetingKeyHashes);
  let deletedCount = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && hashes.has(row.targeting_key_hash)) {
      rows.splice(index, 1);
      deletedCount += 1;
    }
  }
  return {
    appId: identity.appId,
    idType: identity.idType,
    targetingKeyHashes: identity.targetingKeyHashes,
    deletedCount,
  };
}
