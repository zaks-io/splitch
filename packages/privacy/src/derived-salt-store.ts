/**
 * SaltStore backed by one deployment root secret. Each App/version pair is
 * derived; the root is never used as a Targeting Key HMAC key.
 */

import { deriveAppPrivacySalt } from "./derive-app-salt";
import type { KeyVersion, SaltBytes, SaltStore } from "./salt-store";

export const DEFAULT_PRIVACY_KEY_VERSION: KeyVersion = "v1";

/** Committed local/pr-ci fixture. Never a hosted fallback. */
export const LOCAL_PRIVACY_SALT_FIXTURE = "splitch-local-evaluation-salt";

export interface DerivedSaltStoreOptions {
  rootSecret: string | SaltBytes;
  currentKeyVersion?: KeyVersion;
  /**
   * Versions `saltFor` may derive. Defaults to the current version only.
   * Historical versions stay resolvable when listed (lazy rotation).
   */
  allowedKeyVersions?: readonly KeyVersion[];
}

export function makeDerivedSaltStore(options: DerivedSaltStoreOptions): SaltStore {
  const currentKeyVersion = options.currentKeyVersion ?? DEFAULT_PRIVACY_KEY_VERSION;
  const allowed = new Set(options.allowedKeyVersions ?? [currentKeyVersion]);
  if (!allowed.has(currentKeyVersion)) {
    throw new Error("privacy: currentKeyVersion must be in allowedKeyVersions");
  }

  return {
    async currentKeyVersion() {
      return currentKeyVersion;
    },
    async saltFor(appId, keyVersion) {
      if (!allowed.has(keyVersion)) {
        throw new Error(`privacy: unknown salt version ${keyVersion}`);
      }
      return deriveAppPrivacySalt({
        rootSecret: options.rootSecret,
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
