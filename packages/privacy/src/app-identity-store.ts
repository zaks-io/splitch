/**
 * Persist App identity epochs. Memory stores keep plaintext keys for tests.
 * KV stores wrap each epoch under the deployment-root KEK (ADR-0044).
 */

import {
  type AppIdentityExclusive,
  type AppIdentityKv,
  makeInProcessAppIdentityExclusive,
  putWrappedAppIdentityIfAbsent,
} from "./app-identity-exclusive";
import {
  generateAppIdentityKey,
  INITIAL_APP_IDENTITY_KEY_VERSION,
  nextAppIdentityVersion,
} from "./app-identity-key";
import {
  ACTIVE_APP_IDENTITY_LIFECYCLE,
  type AppIdentityLifecycle,
  type AppIdentityLifecycleCheckpoint,
  assertAppIdentityActivationAllowed,
  beginCompromisedAppIdentityLifecycle,
  withAppIdentityLifecycleCheckpoint,
} from "./app-identity-lifecycle";
import {
  type AppIdentityRecord,
  assertCanonicalAppIdentityRecord,
  cloneAppIdentityRecord,
  copyAppIdentityKey,
  defaultAppEntityIdentityRecordKey,
  parseWrappedAppIdentityRecord,
  unwrapAppIdentityRecord,
  wrapAppIdentityRecord,
} from "./app-identity-record";
import { HISTORICAL_SHARED_ROOT_KEY_VERSIONS } from "./derived-salt-store-versions";
import { utf8Bytes } from "./hmac";
import type { SaltBytes } from "./salt-store";

export interface AppIdentityStore {
  load(appId: string): Promise<AppIdentityRecord | null>;
  save(appId: string, record: AppIdentityRecord): Promise<void>;
  runExclusive<T>(appId: string, fn: () => Promise<T>): Promise<T>;
  putIfAbsent(appId: string, record: AppIdentityRecord): Promise<AppIdentityRecord>;
}

export function mintInitialAppIdentityRecord(rootSecret: string | SaltBytes): AppIdentityRecord {
  const compatibility = rootSecretBytes(rootSecret);
  return {
    currentVersion: INITIAL_APP_IDENTITY_KEY_VERSION,
    lifecycle: ACTIVE_APP_IDENTITY_LIFECYCLE,
    epochs: [
      ...HISTORICAL_SHARED_ROOT_KEY_VERSIONS.map((version) => ({
        version,
        role: "lookup" as const,
        key: copyAppIdentityKey(compatibility),
      })),
      {
        version: INITIAL_APP_IDENTITY_KEY_VERSION,
        role: "active" as const,
        key: generateAppIdentityKey(),
      },
    ],
  };
}

export function makeMemoryAppIdentityStore(
  initial?: ReadonlyMap<string, AppIdentityRecord>,
  exclusive: AppIdentityExclusive = makeInProcessAppIdentityExclusive(),
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
    runExclusive(appId, fn) {
      return exclusive.runExclusive(appId, fn);
    },
    putIfAbsent(appId, record) {
      return exclusive.runExclusive(appId, async () => {
        const existing = records.get(appId);
        if (existing !== undefined) {
          return cloneAppIdentityRecord(existing);
        }
        const minted = cloneAppIdentityRecord(record);
        records.set(appId, minted);
        return cloneAppIdentityRecord(minted);
      });
    },
  };
}

export function makeKvAppIdentityStore(options: {
  kv: AppIdentityKv;
  rootSecret: string | SaltBytes;
  recordKey?: (appId: string) => string;
  exclusive?: AppIdentityExclusive;
  putIfAbsent?: (recordKey: string, value: string) => Promise<string>;
}): AppIdentityStore {
  const recordKey = options.recordKey ?? defaultAppEntityIdentityRecordKey;
  const exclusive = options.exclusive ?? makeInProcessAppIdentityExclusive();
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
    runExclusive(appId, fn) {
      return exclusive.runExclusive(appId, fn);
    },
    async putIfAbsent(appId, record) {
      return exclusive.runExclusive(appId, async () => {
        const wrapped = JSON.stringify(
          await wrapAppIdentityRecord(record, options.rootSecret, appId),
        );
        const winner =
          options.putIfAbsent === undefined
            ? await putWrappedAppIdentityIfAbsent(options.kv, recordKey(appId), wrapped)
            : await options.putIfAbsent(recordKey(appId), wrapped);
        return unwrapAppIdentityRecord(
          parseWrappedAppIdentityRecord(winner),
          options.rootSecret,
          appId,
        );
      });
    },
  };
}

export async function provisionAppIdentity(
  store: AppIdentityStore,
  appId: string,
  rootSecret: string | SaltBytes,
): Promise<AppIdentityRecord> {
  const existing = await store.load(appId);
  if (existing !== null) {
    return assertCanonicalAppIdentityRecord(existing);
  }
  return assertCanonicalAppIdentityRecord(
    await store.putIfAbsent(appId, mintInitialAppIdentityRecord(rootSecret)),
  );
}

export async function requireAppIdentityRecord(
  store: AppIdentityStore,
  appId: string,
): Promise<AppIdentityRecord> {
  const loaded = await store.load(appId);
  if (loaded === null) {
    throw new Error("privacy: App identity is unprovisioned");
  }
  return assertCanonicalAppIdentityRecord(loaded);
}

export async function beginCompromisedAppIdentityRotation(
  store: AppIdentityStore,
  appId: string,
): Promise<AppIdentityRecord> {
  return store.runExclusive(appId, async () => {
    const current = await requireAppIdentityRecord(store, appId);
    if (current.lifecycle.state !== "active") {
      return current;
    }
    const updated = withLifecycle(current, beginCompromisedAppIdentityLifecycle());
    await store.save(appId, updated);
    return updated;
  });
}

export async function recordAppIdentityLifecycleCheckpoint(
  store: AppIdentityStore,
  appId: string,
  checkpoint: AppIdentityLifecycleCheckpoint,
): Promise<AppIdentityRecord> {
  return store.runExclusive(appId, async () => {
    const current = await requireAppIdentityRecord(store, appId);
    const updated = withLifecycle(
      current,
      withAppIdentityLifecycleCheckpoint(current.lifecycle, checkpoint),
    );
    await store.save(appId, updated);
    return updated;
  });
}

export async function activateCompromisedAppIdentityEpoch(
  store: AppIdentityStore,
  appId: string,
): Promise<AppIdentityRecord> {
  return store.runExclusive(appId, async () => {
    const current = await requireAppIdentityRecord(store, appId);
    assertAppIdentityActivationAllowed(current.lifecycle);
    const nextVersion = nextAppIdentityVersion(current.currentVersion);
    const updated: AppIdentityRecord = {
      currentVersion: nextVersion,
      lifecycle: ACTIVE_APP_IDENTITY_LIFECYCLE,
      epochs: [
        ...current.epochs.map((epoch) =>
          epoch.role === "active" ? { ...epoch, role: "retained" as const } : epoch,
        ),
        { version: nextVersion, role: "active", key: generateAppIdentityKey() },
      ],
    };
    await store.save(appId, updated);
    return updated;
  });
}

/** Completes the compromised lifecycle with every required checkpoint. */
export async function advanceAppIdentityEpoch(
  store: AppIdentityStore,
  appId: string,
): Promise<AppIdentityRecord> {
  await beginCompromisedAppIdentityRotation(store, appId);
  await recordAppIdentityLifecycleCheckpoint(store, appId, {
    runsEnded: true,
    clientKeysRevoked: true,
    purge: {
      assignments: true,
      analytics: true,
      idempotency: true,
      export: true,
      deletion: true,
    },
  });
  return activateCompromisedAppIdentityEpoch(store, appId);
}

export async function rewrapKvAppIdentityRecord(options: {
  kv: AppIdentityKv;
  appId: string;
  oldRootSecret: string | SaltBytes;
  newRootSecret: string | SaltBytes;
  recordKey?: (appId: string) => string;
  exclusive?: AppIdentityExclusive;
}): Promise<void> {
  const previous = makeKvAppIdentityStore({
    kv: options.kv,
    rootSecret: options.oldRootSecret,
    recordKey: options.recordKey,
    exclusive: options.exclusive,
  });
  const record = await previous.load(options.appId);
  if (record === null) {
    throw new Error("privacy: no App identity record to rewrap");
  }
  const next = makeKvAppIdentityStore({
    kv: options.kv,
    rootSecret: options.newRootSecret,
    recordKey: options.recordKey,
    exclusive: options.exclusive,
  });
  await next.save(options.appId, record);
}

function withLifecycle(
  record: AppIdentityRecord,
  lifecycle: AppIdentityLifecycle,
): AppIdentityRecord {
  return { currentVersion: record.currentVersion, epochs: record.epochs, lifecycle };
}

function rootSecretBytes(rootSecret: string | SaltBytes): SaltBytes {
  if (typeof rootSecret === "string") {
    if (rootSecret.length === 0) {
      throw new Error("privacy: empty root privacy secret");
    }
    return utf8Bytes(rootSecret);
  }
  if (rootSecret.length === 0) {
    throw new Error("privacy: empty root privacy secret");
  }
  return rootSecret;
}
