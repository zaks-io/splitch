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

/**
 * Resolves App-scoped secret salt material. Implementations back this with a
 * Worker secret / KV / DO. Async because edge secret reads are async; callers
 * await. Fail loud: a missing salt for a known version is a hard error, never a
 * silent empty-string fallback (that would weaken the HMAC to a known value).
 */
export interface SaltStore {
  /**
   * The salt version to stamp on NEW hashes for this App (the latest active
   * version). Lazy rotation means this can advance without rewriting old rows.
   */
  currentKeyVersion(appId: string): Promise<KeyVersion>;

  /**
   * The raw secret salt bytes for `(appId, keyVersion)`. MUST throw if the
   * version is unknown for the App — a wrong or empty salt silently corrupts
   * every derived hash and breaks export/delete matching.
   */
  saltFor(appId: string, keyVersion: KeyVersion): Promise<Uint8Array>;
}
