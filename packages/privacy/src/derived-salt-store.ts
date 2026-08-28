/**
 * SaltStore backed by one deployment root secret plus per-App identity epochs.
 *
 * Current-epoch HMAC keys are random `app_entity_identity_key` values stored
 * (and rewrapped) per App. Historical shared-root versions stay resolvable so
 * retained `v1:` / `local-v1:` rows remain comparable. The root is never the
 * current Targeting Key HMAC key.
 */

import { isAppIdentityKeyVersion } from "./app-identity-key";
import {
  type AppIdentityRecord,
  type AppIdentityStore,
  makeMemoryAppIdentityStore,
  mintInitialAppIdentityRecord,
} from "./app-identity-store";
import { utf8Bytes } from "./hmac";
import type { KeyVersion, SaltBytes, SaltStore } from "./salt-store";

/** Current write-path identity epoch label for a newly minted App. */
export const DEFAULT_PRIVACY_KEY_VERSION: KeyVersion = "app-v1";

/**
 * Pre-App-identity prefixes. HMAC key material is the raw root secret so
 * retained Evaluation (`local-v1:`) and Metric Event (`v1:`) rows stay
 * recomputable. Current writes must not emit these prefixes.
 */
export const HISTORICAL_SHARED_ROOT_KEY_VERSIONS = ["local-v1", "v1"] as const;

/** Committed local/pr-ci fixture. Never a hosted fallback. */
export const LOCAL_PRIVACY_SALT_FIXTURE = "splitch-local-evaluation-salt";

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
    const existing = await identityStore.load(appId);
    if (existing) return existing;
    const minted = mintInitialAppIdentityRecord();
    await identityStore.save(appId, minted);
    const stored = await identityStore.load(appId);
    return stored ?? minted;
  }

  return {
    async currentKeyVersion(appId) {
      return (await ensureCurrent(appId)).currentVersion;
    },
    async saltFor(appId, keyVersion) {
      assertAllowed(keyVersion);
      if (isHistoricalSharedRootKeyVersion(keyVersion)) {
        return rootSecretBytes(rootSecret);
      }
      if (!isAppIdentityKeyVersion(keyVersion)) {
        throw new Error(`privacy: unknown salt version ${keyVersion}`);
      }
      const loaded = await identityStore.load(appId);
      const record = loaded ?? (await ensureCurrent(appId));
      const epoch = record.epochs.find((candidate) => candidate.version === keyVersion);
      if (!epoch) {
        throw new Error(`privacy: unknown salt version ${keyVersion}`);
      }
      return epoch.key;
    },
    async retainedKeyVersions(appId) {
      const loaded = await identityStore.load(appId);
      const appVersions = loaded === null ? [] : loaded.epochs.map((epoch) => epoch.version);
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
