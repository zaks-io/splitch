import type { KeyVersion } from "./salt-store";

/** Current write-path identity epoch label for a newly minted App. */
export const DEFAULT_PRIVACY_KEY_VERSION: KeyVersion = "app-v1";

/**
 * Pre-App-identity prefixes. Compatibility key material is snapshotted into the
 * App identity record so KEK/root rewrap cannot change retained hashes.
 * Current writes must not emit these prefixes.
 */
export const HISTORICAL_SHARED_ROOT_KEY_VERSIONS = ["local-v1", "v1"] as const;

export function isHistoricalSharedRootKeyVersion(keyVersion: KeyVersion): boolean {
  return (HISTORICAL_SHARED_ROOT_KEY_VERSIONS as readonly string[]).includes(keyVersion);
}
