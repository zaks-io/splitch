/**
 * App identity record shape and mint/merge helpers. Historical shared-root
 * epochs are lookup-only compatibility material pinned at first provision.
 */

import { generateAppIdentityKey, INITIAL_APP_IDENTITY_KEY_VERSION } from "./app-identity-key";
import { toHex, utf8Bytes } from "./hmac";
import type { KeyVersion, SaltBytes } from "./salt-store";

/**
 * Pre-App-identity prefixes. HMAC key material is the shared-root bytes pinned
 * at first provision so retained `v1:` / `local-v1:` rows stay comparable.
 */
export const HISTORICAL_SHARED_ROOT_KEY_VERSIONS = ["local-v1", "v1"] as const;

export const APP_IDENTITY_RECORD_SCHEMA_VERSION = 1;

export interface AppIdentityEpoch {
  version: KeyVersion;
  key: SaltBytes;
}

export interface AppIdentityRecord {
  currentVersion: KeyVersion;
  epochs: readonly AppIdentityEpoch[];
}

function historicalCompatibilityKey(rootSecret: string | SaltBytes): SaltBytes {
  if (typeof rootSecret === "string") {
    if (rootSecret.length === 0) {
      throw new Error("privacy: empty root privacy secret");
    }
    return utf8Bytes(rootSecret);
  }
  if (rootSecret.length === 0) {
    throw new Error("privacy: empty root privacy secret");
  }
  return new Uint8Array(rootSecret) as SaltBytes;
}

function historicalCompatibilityEpochs(rootSecret: string | SaltBytes): AppIdentityEpoch[] {
  const key = historicalCompatibilityKey(rootSecret);
  return HISTORICAL_SHARED_ROOT_KEY_VERSIONS.map((version) => ({
    version,
    key: new Uint8Array(key) as SaltBytes,
  }));
}

/**
 * First provision: pin lookup-only historical shared-root material and mint one
 * random active App epoch. Omit `rootSecret` only in tests that seed App epochs
 * without compatibility keys.
 */
export function mintInitialAppIdentityRecord(rootSecret?: string | SaltBytes): AppIdentityRecord {
  const epochs: AppIdentityEpoch[] = [];
  if (rootSecret !== undefined) {
    epochs.push(...historicalCompatibilityEpochs(rootSecret));
  }
  epochs.push({
    version: INITIAL_APP_IDENTITY_KEY_VERSION,
    key: generateAppIdentityKey(),
  });
  return { currentVersion: INITIAL_APP_IDENTITY_KEY_VERSION, epochs };
}

function recordHasHistoricalCompatibility(record: AppIdentityRecord): boolean {
  const versions = new Set(record.epochs.map((epoch) => epoch.version));
  return HISTORICAL_SHARED_ROOT_KEY_VERSIONS.every((version) => versions.has(version));
}

export function withHistoricalCompatibility(
  record: AppIdentityRecord,
  rootSecret: string | SaltBytes,
): AppIdentityRecord {
  if (recordHasHistoricalCompatibility(record)) return cloneAppIdentityRecord(record);
  return mergeAppIdentityRecords(record, {
    currentVersion: record.currentVersion,
    epochs: historicalCompatibilityEpochs(rootSecret),
  });
}

/** Deterministic current write key when a raced mint retained extra `app-vN` keys. */
export function canonicalCurrentKey(record: AppIdentityRecord): SaltBytes {
  const keys = record.epochs
    .filter((epoch) => epoch.version === record.currentVersion)
    .map((epoch) => epoch.key);
  const first = keys[0];
  if (first === undefined) {
    throw new Error(
      `privacy: App identity record is missing current epoch ${record.currentVersion}`,
    );
  }
  return keys.reduce((canonical, key) => (toHex(key) < toHex(canonical) ? key : canonical), first);
}

export function mergeAppIdentityRecords(
  existing: AppIdentityRecord,
  incoming: AppIdentityRecord,
): AppIdentityRecord {
  const epochs = existing.epochs.map(cloneEpoch);
  const seen = new Set(existing.epochs.map(epochIdentity));
  for (const epoch of incoming.epochs) {
    const identity = epochIdentity(epoch);
    if (seen.has(identity)) continue;
    epochs.push(cloneEpoch(epoch));
    seen.add(identity);
  }
  return {
    currentVersion: newerCurrentVersion(existing.currentVersion, incoming.currentVersion),
    epochs,
  };
}

export function cloneAppIdentityRecord(record: AppIdentityRecord): AppIdentityRecord {
  return {
    currentVersion: record.currentVersion,
    epochs: record.epochs.map(cloneEpoch),
  };
}

function cloneEpoch(epoch: AppIdentityEpoch): AppIdentityEpoch {
  return { version: epoch.version, key: new Uint8Array(epoch.key) as SaltBytes };
}

function epochIdentity(epoch: AppIdentityEpoch): string {
  return `${epoch.version}:${toHex(epoch.key)}`;
}

function newerCurrentVersion(existing: KeyVersion, incoming: KeyVersion): KeyVersion {
  const existingNumber = Number.parseInt(existing.replace(/^app-v/u, ""), 10);
  const incomingNumber = Number.parseInt(incoming.replace(/^app-v/u, ""), 10);
  if (Number.isFinite(incomingNumber) && Number.isFinite(existingNumber)) {
    return incomingNumber > existingNumber ? incoming : existing;
  }
  return existing;
}
