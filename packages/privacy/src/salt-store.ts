/**
 * Salt-store seam for App-scoped identity-key material.
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
   * The salt version to stamp on NEW hashes for this App (the latest active
   * version). Lazy rotation means this can advance without rewriting old rows.
   */
  currentKeyVersion(appId: string): Promise<KeyVersion>;

  /**
   * The raw secret salt bytes for `(appId, keyVersion)`. MUST throw if the
   * version is unknown for the App — a wrong or empty salt silently corrupts
   * every derived hash and breaks export/delete matching.
   */
  saltFor(appId: string, keyVersion: KeyVersion): Promise<SaltBytes>;

  /**
   * Every identity epoch that still has retained durable rows for this App,
   * oldest first. Export, deletion, Assignment holdover reads, and Metric Event
   * retries must resolve all of these — not only the current write epoch.
   */
  retainedKeyVersions(appId: string): Promise<readonly KeyVersion[]>;

  /**
   * Every HMAC key that can still produce a `targeting_key_hash` for this
   * version prefix. A raced first mint may retain more than one key under
   * `app-v1`. Implementations that omit this method are treated as a single
   * `saltFor` result.
   */
  saltsFor?(appId: string, keyVersion: KeyVersion): Promise<readonly SaltBytes[]>;
}
