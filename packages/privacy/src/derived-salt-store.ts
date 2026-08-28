/**
 * SaltStore backed by one deployment root secret plus per-App identity epochs.
 *
 * Current-epoch HMAC keys are random `app_entity_identity_key` values stored
 * (and rewrapped) per App. Historical shared-root versions stay resolvable so
 * retained `v1:` / `local-v1:` rows remain comparable. The live root is never
 * the current Targeting Key HMAC key and is not used to recompute historical
 * hashes after provision.
 */

import {
  canonicalCurrentKey,
  HISTORICAL_SHARED_ROOT_KEY_VERSIONS as historicalSharedRootKeyVersions,
  mintInitialAppIdentityRecord,
  withHistoricalCompatibility,
} from "./app-identity-record";
import { toHex } from "./hmac";
import {
  type AppIdentityRecord,
  type AppIdentityStore,
  makeMemoryAppIdentityStore,
} from "./app-identity-store";
import type { KeyVersion, SaltBytes, SaltStore } from "./salt-store";

/** Current write-path identity epoch label for a newly minted App. */
export const DEFAULT_PRIVACY_KEY_VERSION: KeyVersion = "app-v1";

export const HISTORICAL_SHARED_ROOT_KEY_VERSIONS = historicalSharedRootKeyVersions;

/** Committed local/pr-ci fixture. Never a hosted fallback. */
export const LOCAL_PRIVACY_SALT_FIXTURE = "splitch-local-evaluation-salt";

const provisionLocks = new WeakMap<AppIdentityStore, Map<string, Promise<AppIdentityRecord>>>();

export interface IdentitySaltStoreOptions {
  rootSecret: string | SaltBytes;
  identityStore: AppIdentityStore;
  /**
   * Extra allowlist. Defaults to historical shared-root prefixes plus every
   * stored App epoch. Unknown versions still fail loud.
   */
  allowedKeyVersions?: readonly KeyVersion[];
}

export interface DerivedSaltStoreOptions {
  rootSecret: string | SaltBytes;
  identityStore?: AppIdentityStore;
  /**
   * Rejected when it names a historical shared-root prefix. The live current
   * version comes from the App identity record, not this option.
   */
  currentKeyVersion?: KeyVersion;
  allowedKeyVersions?: readonly KeyVersion[];
}

export function isHistoricalSharedRootKeyVersion(keyVersion: KeyVersion): boolean {
  return (HISTORICAL_SHARED_ROOT_KEY_VERSIONS as readonly string[]).includes(keyVersion);
}

export function makeIdentitySaltStore(options: IdentitySaltStoreOptions): SaltStore {
  const allowed = options.allowedKeyVersions ? new Set(options.allowedKeyVersions) : null;
  const rootSecret = options.rootSecret;
  const identityStore = options.identityStore;

  function assertAllowed(keyVersion: KeyVersion): void {
    if (allowed && !allowed.has(keyVersion)) {
      throw new Error(`privacy: unknown salt version ${keyVersion}`);
    }
  }

  async function ensureCurrent(appId: string): Promise<AppIdentityRecord> {
    let locks = provisionLocks.get(identityStore);
    if (locks === undefined) {
      locks = new Map();
      provisionLocks.set(identityStore, locks);
    }
    const inflight = locks.get(appId);
    if (inflight) return inflight;
    const pending = provisionAppIdentity(appId).finally(() => {
      if (locks.get(appId) === pending) locks.delete(appId);
    });
    locks.set(appId, pending);
    return pending;
  }

  async function provisionAppIdentity(appId: string): Promise<AppIdentityRecord> {
    const existing = await identityStore.load(appId);
    if (existing) {
      const complete = withHistoricalCompatibility(existing, rootSecret);
      if (complete.epochs.length !== existing.epochs.length) {
        await identityStore.save(appId, complete);
        return (await identityStore.load(appId)) ?? complete;
      }
      return existing;
    }
    const minted = mintInitialAppIdentityRecord(rootSecret);
    await identityStore.save(appId, minted);
    return (await identityStore.load(appId)) ?? minted;
  }

  async function saltsForVersion(appId: string, keyVersion: KeyVersion): Promise<SaltBytes[]> {
    assertAllowed(keyVersion);
    const record = await ensureCurrent(appId);
    const keys = record.epochs
      .filter((epoch) => epoch.version === keyVersion)
      .map((epoch) => epoch.key);
    if (keyVersion === record.currentVersion && keys.length > 1) {
      const canonical = canonicalCurrentKey(record);
      const canonicalHex = toHex(canonical);
      return [canonical, ...keys.filter((key) => toHex(key) !== canonicalHex)];
    }
    return keys;
  }

  return {
    async currentKeyVersion(appId) {
      return (await ensureCurrent(appId)).currentVersion;
    },
    async saltFor(appId, keyVersion) {
      const salts = await saltsForVersion(appId, keyVersion);
      const salt = salts[0];
      if (salt === undefined) {
        throw new Error(`privacy: unknown salt version ${keyVersion}`);
      }
      return salt;
    },
    async saltsFor(appId, keyVersion) {
      const salts = await saltsForVersion(appId, keyVersion);
      if (salts.length === 0) {
        throw new Error(`privacy: unknown salt version ${keyVersion}`);
      }
      return salts;
    },
    async retainedKeyVersions(appId) {
      const loaded = await identityStore.load(appId);
      const appVersions: KeyVersion[] = [];
      const seen = new Set<string>(HISTORICAL_SHARED_ROOT_KEY_VERSIONS);
      for (const epoch of loaded?.epochs ?? []) {
        if (seen.has(epoch.version)) continue;
        seen.add(epoch.version);
        appVersions.push(epoch.version);
      }
      const versions = [...HISTORICAL_SHARED_ROOT_KEY_VERSIONS, ...appVersions];
      return allowed ? versions.filter((version) => allowed.has(version)) : versions;
    },
  };
}

/**
 * Convenience store with an isolated in-memory identity map. Each call mints
 * independent random App keys. Share an `identityStore` (or a KV adapter) when
 * two store instances must see the same epochs.
 */
export function makeDerivedSaltStore(options: DerivedSaltStoreOptions): SaltStore {
  if (
    options.currentKeyVersion !== undefined &&
    isHistoricalSharedRootKeyVersion(options.currentKeyVersion)
  ) {
    throw new Error(
      `privacy: currentKeyVersion ${options.currentKeyVersion} is a historical shared-root epoch`,
    );
  }
  return makeIdentitySaltStore({
    rootSecret: options.rootSecret,
    identityStore: options.identityStore ?? makeMemoryAppIdentityStore(),
    allowedKeyVersions: options.allowedKeyVersions,
  });
}

export function resolvePrivacyRootSecret(input: {
  configuredSalt?: string;
  localFixtureAllowed: boolean;
}): string {
  if (input.configuredSalt !== undefined && input.configuredSalt.length > 0) {
    return input.configuredSalt;
  }
  if (input.localFixtureAllowed) {
    return LOCAL_PRIVACY_SALT_FIXTURE;
  }
  throw new Error("EVALUATION_PRIVACY_SALT is required outside local targets");
}
