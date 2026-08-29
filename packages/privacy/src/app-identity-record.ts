/**
 * Canonical App identity record shape, wrap/unwrap, and schema parsing.
 */

import {
  deriveAppIdentityKek,
  isAppIdentityKeyVersion,
  unwrapAppIdentityKey,
  type WrappedAppIdentityKey,
  wrapAppIdentityKey,
} from "./app-identity-key";
import { type AppIdentityLifecycle, parseAppIdentityLifecycle } from "./app-identity-lifecycle";
import { HISTORICAL_SHARED_ROOT_KEY_VERSIONS } from "./derived-salt-store-versions";
import type { KeyVersion, SaltBytes } from "./salt-store";

export const APP_IDENTITY_RECORD_SCHEMA_VERSION = 2;

/** Must match `appEntityIdentityKey` in @splitch/contracts. */
export function defaultAppEntityIdentityRecordKey(appId: string): string {
  return `app:${appId}:entity-identity`;
}

type AppIdentityEpochRole = "lookup" | "retained" | "active";

export interface AppIdentityEpoch {
  version: KeyVersion;
  key: SaltBytes;
  role: AppIdentityEpochRole;
}

export interface AppIdentityRecord {
  currentVersion: KeyVersion;
  epochs: readonly AppIdentityEpoch[];
  lifecycle: AppIdentityLifecycle;
}

export interface WrappedAppIdentityEpoch {
  version: KeyVersion;
  role: AppIdentityEpochRole;
  wrappedKey: WrappedAppIdentityKey;
}

export interface WrappedAppIdentityRecord {
  schemaVersion: typeof APP_IDENTITY_RECORD_SCHEMA_VERSION;
  currentVersion: KeyVersion;
  epochs: readonly WrappedAppIdentityEpoch[];
  lifecycle: AppIdentityLifecycle;
}

export function copyAppIdentityKey(key: SaltBytes): SaltBytes {
  return new Uint8Array(key) as SaltBytes;
}

export function cloneAppIdentityRecord(record: AppIdentityRecord): AppIdentityRecord {
  return assertCanonicalAppIdentityRecord(record);
}

export async function wrapAppIdentityRecord(
  record: AppIdentityRecord,
  rootSecret: string | SaltBytes,
  appId: string,
): Promise<WrappedAppIdentityRecord> {
  const canonical = assertCanonicalAppIdentityRecord(record);
  const kek = await deriveAppIdentityKek(rootSecret, appId);
  const epochs: WrappedAppIdentityEpoch[] = [];
  for (const epoch of canonical.epochs) {
    epochs.push({
      version: epoch.version,
      role: epoch.role,
      wrappedKey: await wrapAppIdentityKey(kek, epoch.key),
    });
  }
  return {
    schemaVersion: APP_IDENTITY_RECORD_SCHEMA_VERSION,
    currentVersion: canonical.currentVersion,
    epochs,
    lifecycle: canonical.lifecycle,
  };
}

export async function unwrapAppIdentityRecord(
  wrapped: WrappedAppIdentityRecord,
  rootSecret: string | SaltBytes,
  appId: string,
): Promise<AppIdentityRecord> {
  const kek = await deriveAppIdentityKek(rootSecret, appId);
  const epochs: AppIdentityEpoch[] = [];
  for (const epoch of wrapped.epochs) {
    epochs.push({
      version: epoch.version,
      role: epoch.role,
      key: await unwrapAppIdentityKey(kek, epoch.wrappedKey),
    });
  }
  return assertCanonicalAppIdentityRecord({
    currentVersion: wrapped.currentVersion,
    epochs,
    lifecycle: wrapped.lifecycle,
  });
}

export function parseWrappedAppIdentityRecord(raw: string): WrappedAppIdentityRecord {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error("privacy: malformed App identity record JSON", { cause });
  }
  const normalized = normalizeWrappedAppIdentityRecord(json);
  if (normalized === null) {
    throw new Error("privacy: invalid App identity record");
  }
  return normalized;
}

export function assertCanonicalAppIdentityRecord(record: AppIdentityRecord): AppIdentityRecord {
  if (record.epochs.length === 0) {
    throw new Error("privacy: App identity record has no epochs");
  }
  if (!isAppIdentityKeyVersion(record.currentVersion)) {
    throw new Error("privacy: current App identity version must be an app-vN epoch");
  }
  const activeVersion = assertUniqueEpochs(record.epochs);
  if (activeVersion !== record.currentVersion) {
    throw new Error("privacy: App identity record must have exactly one active current epoch");
  }
  return {
    currentVersion: record.currentVersion,
    epochs: record.epochs.map((epoch) => ({
      version: epoch.version,
      role: epoch.role,
      key: copyAppIdentityKey(epoch.key),
    })),
    lifecycle: parseAppIdentityLifecycle(record.lifecycle),
  };
}

function assertUniqueEpochs(epochs: readonly AppIdentityEpoch[]): KeyVersion {
  const versions = new Set<string>();
  const active: KeyVersion[] = [];
  for (const epoch of epochs) {
    assertEpochShape(epoch, versions);
    if (epoch.role === "active") {
      active.push(epoch.version);
    }
  }
  if (active.length !== 1 || active[0] === undefined) {
    throw new Error("privacy: App identity record must have exactly one active current epoch");
  }
  return active[0];
}

function assertEpochShape(epoch: AppIdentityEpoch, versions: Set<string>): void {
  if (versions.has(epoch.version)) {
    throw new Error(`privacy: ambiguous App identity epoch ${epoch.version}`);
  }
  versions.add(epoch.version);
  if (epoch.role === "lookup" && isAppIdentityKeyVersion(epoch.version)) {
    throw new Error(`privacy: App identity epoch ${epoch.version} cannot be lookup-only`);
  }
  if (
    epoch.role !== "lookup" &&
    (HISTORICAL_SHARED_ROOT_KEY_VERSIONS as readonly string[]).includes(epoch.version)
  ) {
    throw new Error(`privacy: historical shared-root epoch ${epoch.version} is lookup-only`);
  }
  if (epoch.key.length === 0) {
    throw new Error(`privacy: empty App identity key for ${epoch.version}`);
  }
}

function normalizeWrappedAppIdentityRecord(value: unknown): WrappedAppIdentityRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["schemaVersion", "currentVersion", "epochs", "lifecycle"]))
    return null;
  if (record.schemaVersion !== APP_IDENTITY_RECORD_SCHEMA_VERSION) return null;
  if (typeof record.currentVersion !== "string" || record.currentVersion.length === 0) {
    return null;
  }
  const epochs = normalizeWrappedEpochs(record.epochs);
  if (epochs === null) return null;
  try {
    return {
      schemaVersion: APP_IDENTITY_RECORD_SCHEMA_VERSION,
      currentVersion: record.currentVersion,
      epochs,
      lifecycle: parseAppIdentityLifecycle(record.lifecycle),
    };
  } catch {
    return null;
  }
}

function normalizeWrappedEpochs(value: unknown): WrappedAppIdentityEpoch[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const epochs: WrappedAppIdentityEpoch[] = [];
  for (const epoch of value) {
    const normalized = normalizeWrappedAppIdentityEpoch(epoch);
    if (normalized === null) return null;
    epochs.push(normalized);
  }
  return epochs;
}

function normalizeWrappedAppIdentityEpoch(value: unknown): WrappedAppIdentityEpoch | null {
  if (typeof value !== "object" || value === null) return null;
  const epoch = value as Record<string, unknown>;
  if (!hasExactKeys(epoch, ["version", "role", "wrappedKey"])) return null;
  if (typeof epoch.version !== "string" || epoch.version.length === 0) return null;
  const wrappedKey = normalizeWrappedKey(epoch.wrappedKey);
  if (wrappedKey === null) return null;
  const role = inferEpochRole(epoch.role);
  if (role === null) return null;
  return {
    version: epoch.version,
    role,
    wrappedKey,
  };
}

function normalizeWrappedKey(value: unknown): WrappedAppIdentityKey | null {
  if (typeof value !== "object" || value === null) return null;
  const wrapped = value as Record<string, unknown>;
  if (!hasExactKeys(wrapped, ["iv", "ciphertext"])) return null;
  if (typeof wrapped.iv !== "string" || typeof wrapped.ciphertext !== "string") return null;
  return { iv: wrapped.iv, ciphertext: wrapped.ciphertext };
}

function inferEpochRole(role: unknown): AppIdentityEpochRole | null {
  if (role === "lookup" || role === "retained" || role === "active") return role;
  return null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
