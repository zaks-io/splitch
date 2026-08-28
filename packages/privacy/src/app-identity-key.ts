/**
 * Random per-App `app_entity_identity_key` material (ADR-0044).
 *
 * The live HMAC key is a 32-byte random secret, immutable for one App identity
 * epoch. Routine rotation rewraps that key under a new KEK derived from the
 * deployment root. It does not derive the live key from the root on every call.
 */

import { fromHex, hmacSha256, toHex, utf8Bytes } from "./hmac";
import type { KeyVersion, SaltBytes } from "./salt-store";

const IDENTITY_KEY_BYTES = 32;
const IV_BYTES = 12;
const KEK_PREFIX = "app-entity-identity-kek";
const APP_IDENTITY_VERSION_PATTERN = /^app-v(\d+)$/u;

export const INITIAL_APP_IDENTITY_KEY_VERSION: KeyVersion = "app-v1";

export interface WrappedAppIdentityKey {
  iv: string;
  ciphertext: string;
}

export function generateAppIdentityKey(): SaltBytes {
  return crypto.getRandomValues(new Uint8Array(IDENTITY_KEY_BYTES)) as SaltBytes;
}

export function isAppIdentityKeyVersion(version: KeyVersion): boolean {
  return APP_IDENTITY_VERSION_PATTERN.test(version);
}

export function nextAppIdentityVersion(current: KeyVersion): KeyVersion {
  const number = appIdentityVersionNumber(current);
  if (number === null) {
    throw new Error(`privacy: cannot advance non-app identity version ${current}`);
  }
  return `app-v${number + 1}`;
}

/** Numeric suffix of `app-vN`, or null when the label is not an App epoch. */
export function appIdentityVersionNumber(version: KeyVersion): number | null {
  const match = APP_IDENTITY_VERSION_PATTERN.exec(version);
  return match ? Number(match[1]) : null;
}

function validateAppIdentityLabel(field: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`privacy: ${field} must not be empty`);
  }
  if (value.includes(":")) {
    throw new Error(`privacy: ${field} must not contain ':'`);
  }
}

function asRootSecret(rootSecret: string | SaltBytes): SaltBytes {
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

/** AES-256 KEK: HMAC_SHA256(root, "app-entity-identity-kek:" + appId). */
export async function deriveAppIdentityKek(
  rootSecret: string | SaltBytes,
  appId: string,
): Promise<SaltBytes> {
  validateAppIdentityLabel("appId", appId);
  const digest = await hmacSha256(asRootSecret(rootSecret), `${KEK_PREFIX}:${appId}`);
  return new Uint8Array(digest) as SaltBytes;
}

export async function wrapAppIdentityKey(
  kek: SaltBytes,
  plaintext: SaltBytes,
): Promise<WrappedAppIdentityKey> {
  if (plaintext.length === 0) {
    throw new Error("privacy: empty App entity identity key");
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await crypto.subtle.importKey("raw", kek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  return { iv: toHex(iv), ciphertext: toHex(ciphertext) };
}

export async function unwrapAppIdentityKey(
  kek: SaltBytes,
  wrapped: WrappedAppIdentityKey,
): Promise<SaltBytes> {
  const iv = fromHex(wrapped.iv);
  const ciphertext = fromHex(wrapped.ciphertext);
  const key = await crypto.subtle.importKey("raw", kek, "AES-GCM", false, ["decrypt"]);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext),
    ) as SaltBytes;
  } catch {
    throw new Error("privacy: failed to unwrap App entity identity key");
  }
}
