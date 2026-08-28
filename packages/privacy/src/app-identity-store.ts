/**
 * Persist App identity epochs. Memory stores keep plaintext keys for tests.
 * KV stores wrap each epoch under the deployment-root KEK (ADR-0044).
 */

import {
  deriveAppIdentityKek,
  generateAppIdentityKey,
  nextAppIdentityVersion,
  unwrapAppIdentityKey,
  type WrappedAppIdentityKey,
  wrapAppIdentityKey,
} from "./app-identity-key";
import {
  type AppIdentityEpoch,
  type AppIdentityRecord,
  APP_IDENTITY_RECORD_SCHEMA_VERSION,
  cloneAppIdentityRecord,
  mergeAppIdentityRecords,
  mintInitialAppIdentityRecord,
  withHistoricalCompatibility,
} from "./app-identity-record";
import type { KeyVersion, SaltBytes } from "./salt-store";

export type { AppIdentityEpoch, AppIdentityRecord } from "./app-identity-record";

/** Must match `appEntityIdentityKey` in @splitch/contracts. */
export function defaultAppEntityIdentityRecordKey(appId: string): string {
  return `app:${appId}:entity-identity`;
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

export interface AppIdentitySaveOptions {
  /**
   * When true (default), union incoming epochs with any record already stored
   * for the App. A raced first mint keeps both keys under `app-v1` so hashes
   * already emitted stay resolvable. Rewrap uses `{ merge: false }`.
   */
  merge?: boolean;
}

export interface AppIdentityStore {
  load(appId: string): Promise<AppIdentityRecord | null>;
  save(appId: string, record: AppIdentityRecord, options?: AppIdentitySaveOptions): Promise<void>;
}

export interface AppIdentityKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
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
    async save(appId, record, options) {
      const existing = options?.merge === false ? undefined : records.get(appId);
      const next =
        existing === undefined
          ? cloneAppIdentityRecord(record)
          : mergeAppIdentityRecords(existing, record);
      records.set(appId, next);
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
    async save(appId, record, saveOptions) {
      const existing = saveOptions?.merge === false ? null : await this.load(appId);
      const next = existing === null ? record : mergeAppIdentityRecords(existing, record);
      const wrapped = await wrapAppIdentityRecord(next, options.rootSecret, appId);
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
  const loaded = await previous.load(options.appId);
  if (loaded === null) {
    throw new Error("privacy: no App identity record to rewrap");
  }
  const record = withHistoricalCompatibility(loaded, options.oldRootSecret);
  const next = makeKvAppIdentityStore({
    kv: options.kv,
    rootSecret: options.newRootSecret,
    recordKey: options.recordKey,
  });
  await next.save(options.appId, record, { merge: false });
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
