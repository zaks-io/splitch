/**
 * SaltStore backed by a persisted per-App identity key (ADR-0044).
 *
 * Bootstrap wraps the historical shared-root HMAC key so retained `v1:` and
 * `local-v1:` rows stay comparable. Current writes use that persisted key, not
 * a root-derived salt recomputed on every call. Leftover `app-v1` hashes from
 * the rejected derived-epoch cutover stay resolvable for lookup only.
 */

import { deriveAppPrivacySalt } from "./derive-app-salt";
import {
  computeTargetingKeyHash,
  hashTargetingKeyWithMaterial,
  type TargetingKeyHashInput,
} from "./hash";
import { utf8Bytes } from "./hmac";
import {
  type IdentityKeyPersist,
  loadOrBootstrapAppIdentityKey,
  makeMemoryIdentityKeyPersist,
} from "./identity-key-persist";
import type { KeyVersion, SaltBytes, SaltStore } from "./salt-store";

/** Evaluation write-path epoch. Matches retained Assignment / Exposure prefixes. */
export const EVALUATION_IDENTITY_EPOCH: KeyVersion = "local-v1";

/** Event Ingest write-path epoch. Matches retained Metric Event prefixes. */
export const INGEST_IDENTITY_EPOCH: KeyVersion = "v1";

/** Leftover derived-epoch prefix. Lookup only; never a new write epoch. */
export const LEFTOVER_APP_DERIVED_KEY_VERSION: KeyVersion = "app-v1";

/** Shared-root prefixes whose HMAC key is the raw deployment root. */
export const HISTORICAL_SHARED_ROOT_KEY_VERSIONS = ["local-v1", "v1"] as const;

/** Committed local/pr-ci fixture. Never a hosted fallback. */
export const LOCAL_PRIVACY_SALT_FIXTURE = "splitch-local-evaluation-salt";

export interface IdentitySaltStore extends SaltStore {
  compatibleTargetingKeyHashes(input: TargetingKeyHashInput): Promise<string[]>;
}

export interface PersistedIdentitySaltStoreOptions {
  persist: IdentityKeyPersist;
  rootSecret: string;
  currentKeyVersion: KeyVersion;
}

export function isHistoricalSharedRootKeyVersion(keyVersion: KeyVersion): boolean {
  return (HISTORICAL_SHARED_ROOT_KEY_VERSIONS as readonly string[]).includes(keyVersion);
}

function rootSecretBytes(rootSecret: string): SaltBytes {
  if (rootSecret.length === 0) {
    throw new Error("privacy: empty root privacy secret");
  }
  return utf8Bytes(rootSecret);
}

function uniqueHashes(hashes: readonly string[]): string[] {
  return [...new Set(hashes)];
}

export function makePersistedIdentitySaltStore(
  options: PersistedIdentitySaltStoreOptions,
): IdentitySaltStore {
  if (options.rootSecret.length === 0) {
    throw new Error("privacy: empty root privacy secret");
  }
  if (options.currentKeyVersion.length === 0 || options.currentKeyVersion.includes(":")) {
    throw new Error("privacy: invalid current identity epoch");
  }
  const cache = new Map<string, { epochId: string; identityKey: SaltBytes }>();

  const resolveIdentity = async (appId: string) => {
    const cached = cache.get(appId);
    if (cached) return cached;
    const loaded = await loadOrBootstrapAppIdentityKey({
      persist: options.persist,
      appId,
      kekMaterial: options.rootSecret,
      epochId: options.currentKeyVersion,
    });
    cache.set(appId, loaded);
    return loaded;
  };

  const store: IdentitySaltStore = {
    async currentKeyVersion(appId) {
      return (await resolveIdentity(appId)).epochId;
    },
    async saltFor(appId, keyVersion) {
      if (keyVersion === LEFTOVER_APP_DERIVED_KEY_VERSION) {
        return deriveAppPrivacySalt({
          rootSecret: options.rootSecret,
          appId,
          keyVersion,
        });
      }
      if (isHistoricalSharedRootKeyVersion(keyVersion)) {
        const identity = await resolveIdentity(appId);
        return identity.epochId === keyVersion
          ? identity.identityKey
          : rootSecretBytes(options.rootSecret);
      }
      const identity = await resolveIdentity(appId);
      if (identity.epochId !== keyVersion) {
        throw new Error(`privacy: unknown salt version ${keyVersion}`);
      }
      return identity.identityKey;
    },
    async compatibleTargetingKeyHashes(input) {
      const current = await computeTargetingKeyHash(store, input);
      const rootKey = rootSecretBytes(options.rootSecret);
      const historical = await Promise.all(
        HISTORICAL_SHARED_ROOT_KEY_VERSIONS.map((version) =>
          hashTargetingKeyWithMaterial(rootKey, version, input),
        ),
      );
      const leftover = await hashTargetingKeyWithMaterial(
        await deriveAppPrivacySalt({
          rootSecret: options.rootSecret,
          appId: input.appId,
          keyVersion: LEFTOVER_APP_DERIVED_KEY_VERSION,
        }),
        LEFTOVER_APP_DERIVED_KEY_VERSION,
        input,
      );
      return uniqueHashes([current, ...historical, leftover]);
    },
  };
  return store;
}

export function makeMemoryIdentitySaltStore(options: {
  rootSecret: string;
  currentKeyVersion: KeyVersion;
}): IdentitySaltStore {
  return makePersistedIdentitySaltStore({
    persist: makeMemoryIdentityKeyPersist(),
    rootSecret: options.rootSecret,
    currentKeyVersion: options.currentKeyVersion,
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
