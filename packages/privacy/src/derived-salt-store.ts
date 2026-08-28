/**
 * SaltStore backed by one deployment root secret. Current-epoch salts are
 * App-derived; historical shared-root versions stay resolvable so retained
 * `v1:` / `local-v1:` rows remain comparable. The root is never the current
 * Targeting Key HMAC key.
 */

import { deriveAppPrivacySalt } from "./derive-app-salt";
import { utf8Bytes } from "./hmac";
import type { KeyVersion, SaltBytes, SaltStore } from "./salt-store";

/** Current write-path identity epoch. App-derived; never reused for shared-root hashes. */
export const DEFAULT_PRIVACY_KEY_VERSION: KeyVersion = "app-v1";

/**
 * Pre-App-derivation prefixes. HMAC key material is the raw root secret so
 * retained Evaluation (`local-v1:`) and Metric Event (`v1:`) rows stay
 * recomputable. Current writes must not emit these prefixes.
 */
export const HISTORICAL_SHARED_ROOT_KEY_VERSIONS = ["local-v1", "v1"] as const;

/** Committed local/pr-ci fixture. Never a hosted fallback. */
export const LOCAL_PRIVACY_SALT_FIXTURE = "splitch-local-evaluation-salt";

export interface DerivedSaltStoreOptions {
  rootSecret: string | SaltBytes;
  currentKeyVersion?: KeyVersion;
  /**
   * Versions `saltFor` may resolve. Defaults to the current App-derived epoch
   * plus historical shared-root prefixes so export/delete can recompute old
   * retained hashes without remapping them.
   */
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

export function makeDerivedSaltStore(options: DerivedSaltStoreOptions): SaltStore {
  const currentKeyVersion = options.currentKeyVersion ?? DEFAULT_PRIVACY_KEY_VERSION;
  if (isHistoricalSharedRootKeyVersion(currentKeyVersion)) {
    throw new Error(
      `privacy: currentKeyVersion ${currentKeyVersion} is a historical shared-root epoch`,
    );
  }
  const allowed = new Set(
    options.allowedKeyVersions ?? [currentKeyVersion, ...HISTORICAL_SHARED_ROOT_KEY_VERSIONS],
  );
  if (!allowed.has(currentKeyVersion)) {
    throw new Error("privacy: currentKeyVersion must be in allowedKeyVersions");
  }
  const rootSecret = options.rootSecret;

  return {
    async currentKeyVersion() {
      return currentKeyVersion;
    },
    async saltFor(appId, keyVersion) {
      if (!allowed.has(keyVersion)) {
        throw new Error(`privacy: unknown salt version ${keyVersion}`);
      }
      if (isHistoricalSharedRootKeyVersion(keyVersion)) {
        return rootSecretBytes(rootSecret);
      }
      return deriveAppPrivacySalt({
        rootSecret,
        appId,
        keyVersion,
      });
    },
  };
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
