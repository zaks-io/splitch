/**
 * Targeting-key hashing: the derived `targeting_key_hash` that durable Entity
 * stores use in place of the raw Targeting Key.
 *
 * Construction (docs/spec/platform/privacy-data-lifecycle.md / ADR-0044):
 *
 *   targeting_key_hash =
 *     epoch_id + ":" + HMAC_SHA256(app_entity_identity_key,
 *                                  id_type + ":" + targetingKey)
 *
 * The HMAC key is the persisted App identity key for the active epoch, not a
 * salt derived from the deployment root on every call. Historical `v1:` /
 * `local-v1:` prefixes stay pinned to the shared-root algorithm so retained
 * rows remain comparable. Leftover `app-v1:` hashes stay lookup-only.
 *
 * WHY Web Crypto (crypto.subtle), not node:crypto: this runs on the Cloudflare
 * Worker edge runtime, which exposes the WebCrypto API and not Node's crypto.
 * subtle.sign is async, so the public API is async — callers await it.
 *
 * The output is `epoch_id:<hex digest>`. The raw Targeting Key is the HMAC
 * MESSAGE, never echoed. Export/delete recomputes every compatible hash for
 * the App so joins, retries, and deletion still find retained rows.
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

/** HMAC under caller-supplied key material and an explicit epoch prefix. */
export async function hashTargetingKeyWithMaterial(
  hmacKey: SaltBytes,
  keyVersion: KeyVersion,
  input: Pick<TargetingKeyHashInput, "idType" | "targetingKey">,
): Promise<string> {
  if (hmacKey.length === 0) {
    throw new Error(`privacy: empty salt for version=${keyVersion}`);
  }
  const digest = await hmacSha256Hex(
    hmacKey,
    targetingHashMessage(input.idType, input.targetingKey),
  );
  return `${keyVersion}:${digest}`;
}

/**
 * Current write hash plus every retained-epoch hash that must still join or
 * retry. Plain SaltStore implementations return only the current hash.
 */
export async function targetingKeyHashesForLookup(
  store: SaltStore,
  input: TargetingKeyHashInput,
): Promise<string[]> {
  if (typeof store.compatibleTargetingKeyHashes === "function") {
    return store.compatibleTargetingKeyHashes(input);
  }
  return [await computeTargetingKeyHash(store, input)];
}

/** The salt version a hash was derived under (the prefix before the first `:`). */
export function keyVersionOf(targetingKeyHash: string): KeyVersion {
  const separator = targetingKeyHash.indexOf(":");
  if (separator <= 0) {
    throw new Error(`privacy: malformed targeting_key_hash (no version prefix)`);
  }
  return targetingKeyHash.slice(0, separator);
}
