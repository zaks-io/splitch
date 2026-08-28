/**
 * Salt-store seam for the App-scoped, versioned `app_privacy_salt`.
 *
 * WHY an injected interface and not a concrete store: the secret salt material
 * lives outside this package (a Worker secret binding / KV / DO), and it MUST
 * NOT be hardcoded or bundled. The hash module depends only on this narrow
 * contract so the real secret source is substitutable (prod binding) and a fake
 * is trivial in tests. Rotation is lazy: new Entity rows take the latest version;
 * historical rows keep the version baked into their `targeting_key_hash` prefix,
 * so an old version must remain resolvable until every row using it has expired.
 *
 * Source of truth: docs/spec/platform/privacy-data-lifecycle.md (Entity privacy
 * identity).
 */

/** A salt version label, e.g. `"v1"`. It is the literal prefix on the hash. */
export type KeyVersion = string;

/** Raw HMAC key material backed by an ArrayBuffer, as required by WebCrypto. */
export type SaltBytes = Uint8Array<ArrayBuffer>;

/**
 * Resolves App-scoped secret salt material. Implementations back this with a
 * Worker secret / KV / DO. Async because edge secret reads are async; callers
 * await. Fail loud: a missing salt for a known version is a hard error, never a
 * silent empty-string fallback (that would weaken the HMAC to a known value).
 */
export interface SaltStore {
  /**
   * The identity epoch to stamp on NEW hashes for this App. Routine KEK
   * rotation must not change this value or the underlying identity key.
   */
  currentKeyVersion(appId: string): Promise<KeyVersion>;

  /**
   * The HMAC key for `(appId, keyVersion)`. MUST throw if the version is
   * unknown for the App — a wrong or empty key silently corrupts every derived
   * hash and breaks export/delete matching.
   */
  saltFor(appId: string, keyVersion: KeyVersion): Promise<SaltBytes>;

  /**
   * Current write hash plus retained-epoch hashes that must still join, retry,
   * export, or delete. Optional on test fakes that only have one epoch.
   */
  compatibleTargetingKeyHashes?(input: {
    appId: string;
    idType: string;
    targetingKey: string;
  }): Promise<string[]>;
}
