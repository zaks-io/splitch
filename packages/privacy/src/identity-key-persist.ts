/**
 * Persist and rotate wrapped App identity keys. First persist bootstraps the
 * historical shared-root HMAC key so retained hashes stay comparable. Random
 * keys are minted only by an explicit epoch API (ADR-0044).
 */

import { utf8Bytes } from "./hmac";
import type { SaltBytes } from "./salt-store";
import {
  type AppIdentityKeyRecord,
  parseAppIdentityKeyRecord,
  randomIdentityKey,
  unwrapIdentityKey,
  wrapIdentityKey,
} from "./wrap-identity-key";

export interface IdentityKeyPersist {
  get(appId: string): Promise<AppIdentityKeyRecord | null>;
  put(appId: string, record: AppIdentityKeyRecord): Promise<void>;
}

export interface IdentityKeyKv {
  get(key: string): Promise<string | null>;
  put?(key: string, value: string): Promise<void>;
}

export interface LoadedAppIdentityKey {
  epochId: string;
  identityKey: SaltBytes;
}

export function makeMemoryIdentityKeyPersist(): IdentityKeyPersist {
  const records = new Map<string, AppIdentityKeyRecord>();
  return {
    async get(appId) {
      return records.get(appId) ?? null;
    },
    async put(appId, record) {
      records.set(appId, record);
    },
  };
}

export function makeKvIdentityKeyPersist(
  kv: IdentityKeyKv,
  recordKey: (appId: string) => string,
): IdentityKeyPersist {
  const memory = makeMemoryIdentityKeyPersist();
  return {
    async get(appId) {
      const raw = await kv.get(recordKey(appId));
      if (raw !== null) {
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch (cause) {
          throw new Error("privacy: malformed App identity key record", { cause });
        }
        return parseAppIdentityKeyRecord(json);
      }
      return memory.get(appId);
    },
    async put(appId, record) {
      if (typeof kv.put === "function") {
        await kv.put(recordKey(appId), JSON.stringify(record));
      }
      await memory.put(appId, record);
    },
  };
}

export async function loadOrBootstrapAppIdentityKey(input: {
  persist: IdentityKeyPersist;
  appId: string;
  kekMaterial: string;
  epochId: string;
}): Promise<LoadedAppIdentityKey> {
  const existing = await input.persist.get(input.appId);
  if (existing !== null) {
    return {
      epochId: existing.epochId,
      identityKey: await unwrapIdentityKey({
        kekMaterial: input.kekMaterial,
        record: existing,
      }),
    };
  }
  const identityKey = utf8Bytes(input.kekMaterial);
  const record = await wrapIdentityKey({
    kekMaterial: input.kekMaterial,
    identityKey,
    epochId: input.epochId,
  });
  await input.persist.put(input.appId, record);
  return { epochId: record.epochId, identityKey };
}

export async function mintAppIdentityEpoch(input: {
  persist: IdentityKeyPersist;
  appId: string;
  kekMaterial: string;
  epochId: string;
}): Promise<LoadedAppIdentityKey> {
  const identityKey = randomIdentityKey();
  const record = await wrapIdentityKey({
    kekMaterial: input.kekMaterial,
    identityKey,
    epochId: input.epochId,
  });
  await input.persist.put(input.appId, record);
  return { epochId: record.epochId, identityKey };
}

export async function rewrapAppIdentityKey(input: {
  persist: IdentityKeyPersist;
  appId: string;
  previousKekMaterial: string;
  currentKekMaterial: string;
}): Promise<LoadedAppIdentityKey> {
  const existing = await input.persist.get(input.appId);
  if (existing === null) {
    throw new Error(`privacy: no App identity key to rewrap for ${input.appId}`);
  }
  const identityKey = await unwrapIdentityKey({
    kekMaterial: input.previousKekMaterial,
    record: existing,
  });
  const record = await wrapIdentityKey({
    kekMaterial: input.currentKekMaterial,
    identityKey,
    epochId: existing.epochId,
  });
  await input.persist.put(input.appId, record);
  return { epochId: record.epochId, identityKey };
}
