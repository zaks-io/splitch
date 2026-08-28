/**
 * Persist App identity epochs. Memory stores keep plaintext keys for tests.
 * KV stores wrap each epoch under the deployment-root KEK (ADR-0044).
 */

import {
  deriveAppIdentityKek,
  generateAppIdentityKey,
  INITIAL_APP_IDENTITY_KEY_VERSION,
  nextAppIdentityVersion,
  unwrapAppIdentityKey,
  wrapAppIdentityKey,
  type WrappedAppIdentityKey,
} from "./app-identity-key";
import type { KeyVersion, SaltBytes } from "./salt-store";

export const APP_IDENTITY_RECORD_SCHEMA_VERSION = 1;

/** Must match `appEntityIdentityKey` in @splitch/contracts. */
export function defaultAppEntityIdentityRecordKey(appId: string): string {
  return `app:${appId}:entity-identity`;
}

export interface AppIdentityEpoch {
  version: KeyVersion;
  key: SaltBytes;
}

export interface AppIdentityRecord {
  currentVersion: KeyVersion;
  epochs: readonly AppIdentityEpoch[];
}

export interface WrappedAppIdentityEpoch {
  version: KeyVersion;
  wrappedKey: WrappedAppIdentityKey;
}

export interface WrappedAppIdentityRecord {
  schemaVersion: typeof APP_IDENTITY_RECORD_SCHEMA_VERSION;
  currentVersion: KeyVersion;
  epochs: readonly WrappedAppIdentityEpoch[];
}

export interface AppIdentityStore {
  load(appId: string): Promise<AppIdentityRecord | null>;
  save(appId: string, record: AppIdentityRecord): Promise<void>;
}

export interface AppIdentityKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export function mintInitialAppIdentityRecord(): AppIdentityRecord {
  return {
    currentVersion: INITIAL_APP_IDENTITY_KEY_VERSION,
    epochs: [{ version: INITIAL_APP_IDENTITY_KEY_VERSION, key: generateAppIdentityKey() }],
  };
}

export function makeMemoryAppIdentityStore(
  initial?: ReadonlyMap<string, AppIdentityRecord>,
): AppIdentityStore {
  const records = new Map<string, AppIdentityRecord>();
  if (initial) {
    for (const [appId, record] of initial) {
      records.set(appId, cloneAppIdentityRecord(record));
    }
  }
  return {
    async load(appId) {
      const record = records.get(appId);
      return record === undefined ? null : cloneAppIdentityRecord(record);
    },
    async save(appId, record) {
      records.set(appId, cloneAppIdentityRecord(record));
    },
  };
}

export function makeKvAppIdentityStore(options: {
  kv: AppIdentityKv;
  rootSecret: string | SaltBytes;
  recordKey?: (appId: string) => string;
}): AppIdentityStore {
  const recordKey = options.recordKey ?? defaultAppEntityIdentityRecordKey;
  return {
    async load(appId) {
      const raw = await options.kv.get(recordKey(appId));
      if (raw === null) return null;
      return unwrapAppIdentityRecord(parseWrappedAppIdentityRecord(raw), options.rootSecret, appId);
    },
    async save(appId, record) {
      const wrapped = await wrapAppIdentityRecord(record, options.rootSecret, appId);
      await options.kv.put(recordKey(appId), JSON.stringify(wrapped));
    },
  };
}

export async function advanceAppIdentityEpoch(
  store: AppIdentityStore,
  appId: string,
): Promise<AppIdentityRecord> {
  const current = await store.load(appId);
  if (current === null) {
    const minted = mintInitialAppIdentityRecord();
    await store.save(appId, minted);
    return minted;
  }
  const nextVersion = nextAppIdentityVersion(current.currentVersion);
  const updated: AppIdentityRecord = {
    currentVersion: nextVersion,
    epochs: [...current.epochs, { version: nextVersion, key: generateAppIdentityKey() }],
  };
  await store.save(appId, updated);
  return updated;
}

export async function wrapAppIdentityRecord(
  record: AppIdentityRecord,
  rootSecret: string | SaltBytes,
  appId: string,
): Promise<WrappedAppIdentityRecord> {
  const kek = await deriveAppIdentityKek(rootSecret, appId);
  const epochs: WrappedAppIdentityEpoch[] = [];
  for (const epoch of record.epochs) {
    epochs.push({
      version: epoch.version,
      wrappedKey: await wrapAppIdentityKey(kek, epoch.key),
    });
  }
  return {
    schemaVersion: APP_IDENTITY_RECORD_SCHEMA_VERSION,
    currentVersion: record.currentVersion,
    epochs,
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
      key: await unwrapAppIdentityKey(kek, epoch.wrappedKey),
    });
  }
  return { currentVersion: wrapped.currentVersion, epochs };
}

export async function rewrapKvAppIdentityRecord(options: {
  kv: AppIdentityKv;
  appId: string;
  oldRootSecret: string | SaltBytes;
  newRootSecret: string | SaltBytes;
  recordKey?: (appId: string) => string;
}): Promise<void> {
  const previous = makeKvAppIdentityStore({
    kv: options.kv,
    rootSecret: options.oldRootSecret,
    recordKey: options.recordKey,
  });
  const record = await previous.load(options.appId);
  if (record === null) {
    throw new Error("privacy: no App identity record to rewrap");
  }
  const next = makeKvAppIdentityStore({
    kv: options.kv,
    rootSecret: options.newRootSecret,
    recordKey: options.recordKey,
  });
  await next.save(options.appId, record);
}

export function parseWrappedAppIdentityRecord(raw: string): WrappedAppIdentityRecord {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error("privacy: malformed App identity record JSON", { cause });
  }
  if (!isWrappedAppIdentityRecord(json)) {
    throw new Error("privacy: invalid App identity record");
  }
  return json;
}

function isWrappedAppIdentityRecord(value: unknown): value is WrappedAppIdentityRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== APP_IDENTITY_RECORD_SCHEMA_VERSION) return false;
  if (typeof record.currentVersion !== "string" || record.currentVersion.length === 0) {
    return false;
  }
  if (!Array.isArray(record.epochs) || record.epochs.length === 0) return false;
  return record.epochs.every(isWrappedAppIdentityEpoch);
}

function isWrappedAppIdentityEpoch(value: unknown): value is WrappedAppIdentityEpoch {
  if (typeof value !== "object" || value === null) return false;
  const epoch = value as Record<string, unknown>;
  if (typeof epoch.version !== "string" || epoch.version.length === 0) return false;
  if (typeof epoch.wrappedKey !== "object" || epoch.wrappedKey === null) return false;
  const wrapped = epoch.wrappedKey as Record<string, unknown>;
  return typeof wrapped.iv === "string" && typeof wrapped.ciphertext === "string";
}

function cloneAppIdentityRecord(record: AppIdentityRecord): AppIdentityRecord {
  return {
    currentVersion: record.currentVersion,
    epochs: record.epochs.map((epoch) => ({
      version: epoch.version,
      key: new Uint8Array(epoch.key) as SaltBytes,
    })),
  };
}
