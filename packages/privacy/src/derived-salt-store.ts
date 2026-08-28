/**
 * SaltStore backed by one deployment root secret plus per-App identity epochs.
 *
 * Current-epoch HMAC keys are random `app_entity_identity_key` values stored
 * (and rewrapped) per App. Historical shared-root versions stay resolvable
 * from lookup-only compatibility keys snapshotted at provision. The live root
 * is never the current Targeting Key HMAC key and is never activated for a
 * new App.
 */

import { isAppIdentityKeyVersion } from "./app-identity-key";
import { assertAppIdentityTrafficAllowed } from "./app-identity-lifecycle";
import type { AppIdentityRecord } from "./app-identity-record";
import {
  type AppIdentityStore,
  makeMemoryAppIdentityStore,
  provisionAppIdentity,
  requireAppIdentityRecord,
} from "./app-identity-store";
import {
  DEFAULT_PRIVACY_KEY_VERSION,
  HISTORICAL_SHARED_ROOT_KEY_VERSIONS,
  isHistoricalSharedRootKeyVersion,
} from "./derived-salt-store-versions";
import type { KeyVersion, SaltBytes, SaltStore } from "./salt-store";

export {
  DEFAULT_PRIVACY_KEY_VERSION,
  HISTORICAL_SHARED_ROOT_KEY_VERSIONS,
  isHistoricalSharedRootKeyVersion,
};

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

export function makeIdentitySaltStore(options: IdentitySaltStoreOptions): SaltStore {
  const allowed = options.allowedKeyVersions ? new Set(options.allowedKeyVersions) : null;
  const rootSecret = options.rootSecret;
  const identityStore = options.identityStore;

  function assertAllowed(keyVersion: KeyVersion): void {
    if (allowed && !allowed.has(keyVersion)) {
      throw new Error(`privacy: unknown salt version ${keyVersion}`);
    }
  }

  async function provisioned(appId: string): Promise<AppIdentityRecord> {
    return provisionAppIdentity(identityStore, appId, rootSecret);
  }

  return {
    async currentKeyVersion(appId) {
      const record = await provisioned(appId);
      assertAppIdentityTrafficAllowed(record.lifecycle);
      return record.currentVersion;
    },
    async saltFor(appId, keyVersion) {
      assertAllowed(keyVersion);
      const record = await provisioned(appId);
      if (isHistoricalSharedRootKeyVersion(keyVersion) || isAppIdentityKeyVersion(keyVersion)) {
        const epoch = record.epochs.find((candidate) => candidate.version === keyVersion);
        if (!epoch) {
          throw new Error(`privacy: unknown salt version ${keyVersion}`);
        }
        if (isHistoricalSharedRootKeyVersion(keyVersion) && epoch.role !== "lookup") {
          throw new Error(`privacy: historical shared-root epoch ${keyVersion} is lookup-only`);
        }
        return epoch.key;
      }
      throw new Error(`privacy: unknown salt version ${keyVersion}`);
    },
    async retainedKeyVersions(appId) {
      const record = await requireAppIdentityRecord(identityStore, appId).catch(async (cause) => {
        if (cause instanceof Error && /unprovisioned/u.test(cause.message)) {
          return provisioned(appId);
        }
        throw cause;
      });
      const versions = record.epochs.map((epoch) => epoch.version);
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
