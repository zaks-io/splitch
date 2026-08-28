/**
 * Targeting-key hashing: the derived `targeting_key_hash` that durable Entity
 * stores use in place of the raw Targeting Key.
 *
 * Construction (docs/spec/platform/privacy-data-lifecycle.md, ADR-0044):
 *
 *   targeting_key_hash =
 *     key_version + ":" + HMAC_SHA256(identity_key, id_type + ":" + targetingKey)
 *
 * Current writes use that App's stored `app_entity_identity_key` and an
 * explicit per-App epoch (`app-v1`, `app-v2`, …). Routine root/wrapper rotation
 * rewraps the same key and keeps the same prefix and digest. Historical `v1:`
 * and `local-v1:` prefixes stay pinned to the shared-root algorithm so retained
 * rows remain comparable. A new epoch never reuses those prefixes. The version
 * prefix is a non-secret routing label for export, deletion, and retry.
 *
 * WHY Web Crypto (crypto.subtle), not node:crypto: this runs on the Cloudflare
 * Worker edge runtime, which exposes the WebCrypto API and not Node's crypto.
 * subtle.sign is async, so the public API is async — callers await it.
 *
 * The output is `key_version:<hex digest>`. The raw Targeting Key is the HMAC
 * MESSAGE, never echoed: a digest is one-way, and the identity key is the secret,
 * so the function cannot reproduce the input. Export/delete/retry recompute
 * every retained epoch rather than remapping old rows onto the current hash.
 */

import { hmacSha256Hex } from "./hmac";
import type { KeyVersion, SaltBytes, SaltStore } from "./salt-store";

function validateIdType(idType: string): void {
  if (idType.length === 0) {
    throw new Error("privacy: idType must not be empty");
  }
  if (idType.includes(":")) {
    throw new Error("privacy: idType must not contain ':'");
  }
}

function targetingHashMessage(idType: string, targetingKey: string): string {
  validateIdType(idType);
  return `${idType}:${targetingKey}`;
}

export interface TargetingKeyHashInput {
  appId: string;
  idType: string;
  targetingKey: string;
  /**
   * Pin a specific salt version (used by export/delete, which must recompute the
   * hash under every active version). Omit on the write path to take the App's
   * current version.
   */
  keyVersion?: KeyVersion;
  /**
   * Override `saltFor` when a version has more than one retained key (a raced
   * first mint). The version prefix on the hash still comes from `keyVersion`.
   */
  salt?: SaltBytes;
}

/**
 * Derive the version-prefixed `targeting_key_hash`. Deterministic for the same
 * (keyVersion, salt, idType, targetingKey). Fails loud if the salt store cannot
 * resolve the version — never falls back to an empty or default salt.
 */
export async function computeTargetingKeyHash(
  store: SaltStore,
  input: TargetingKeyHashInput,
): Promise<string> {
  const keyVersion = input.keyVersion ?? (await store.currentKeyVersion(input.appId));
  const salt = input.salt ?? (await store.saltFor(input.appId, keyVersion));
  if (salt.length === 0) {
    throw new Error(`privacy: empty salt for app=${input.appId} version=${keyVersion}`);
  }
  const digest = await hmacSha256Hex(salt, targetingHashMessage(input.idType, input.targetingKey));
  return `${keyVersion}:${digest}`;
}

/** The salt version a hash was derived under (the prefix before the first `:`). */
export function keyVersionOf(targetingKeyHash: string): KeyVersion {
  const separator = targetingKeyHash.indexOf(":");
  if (separator <= 0) {
    throw new Error(`privacy: malformed targeting_key_hash (no version prefix)`);
  }
  return targetingKeyHash.slice(0, separator);
}
