/**
 * Targeting-key hashing: the derived `targeting_key_hash` that durable Entity
 * stores use in place of the raw Targeting Key.
 *
 * Construction (docs/spec/platform/privacy-data-lifecycle.md):
 *
 *   targeting_key_hash =
 *     key_version + ":" + HMAC_SHA256(app_privacy_salt[key_version],
 *                                     id_type + ":" + targetingKey)
 *
 * WHY Web Crypto (crypto.subtle), not node:crypto: this runs on the Cloudflare
 * Worker edge runtime, which exposes the WebCrypto API and not Node's crypto.
 * subtle.sign is async, so the public API is async — callers await it.
 *
 * The output is `key_version:<hex digest>`. The raw Targeting Key is the HMAC
 * MESSAGE, never echoed: a digest is one-way, and the salt is the secret key, so
 * the function cannot reproduce the input. The version is a non-secret routing
 * prefix that lets export/delete recompute the right hash per active salt.
 */

import type { KeyVersion, SaltBytes, SaltStore } from "./salt-store";

const HMAC_PARAMS = { name: "HMAC", hash: "SHA-256" } as const;

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function hmacSha256Hex(salt: SaltBytes, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", salt, HMAC_PARAMS, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(signature);
}

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
  const salt = await store.saltFor(input.appId, keyVersion);
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
