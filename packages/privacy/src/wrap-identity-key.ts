/**
 * AES-GCM wrap for `app_entity_identity_key`. The KEK is SHA-256 of the
 * deployment privacy root; routine rotation rewraps without changing the
 * identity key or epoch (ADR-0044).
 */

import { sha256Bytes, utf8Bytes } from "./hmac";
import type { SaltBytes } from "./salt-store";

export const IDENTITY_KEY_WRAP_SCHEMA_VERSION = 1;
export const IDENTITY_KEY_WRAP_IV_BYTES = 12;
const MINTED_IDENTITY_KEY_BYTES = 32;

export interface AppIdentityKeyRecord {
  schemaVersion: 1;
  epochId: string;
  iv: string;
  ciphertext: string;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKek(kekMaterial: string): Promise<CryptoKey> {
  if (kekMaterial.length === 0) {
    throw new Error("privacy: empty identity-key wrapping secret");
  }
  const digest = await sha256Bytes(utf8Bytes(kekMaterial));
  return crypto.subtle.importKey("raw", asArrayBuffer(digest), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export function parseAppIdentityKeyRecord(value: unknown): AppIdentityKeyRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("privacy: malformed App identity key record");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== IDENTITY_KEY_WRAP_SCHEMA_VERSION) {
    throw new Error("privacy: unknown App identity key record schema");
  }
  if (typeof record.epochId !== "string" || record.epochId.length === 0) {
    throw new Error("privacy: malformed App identity key epoch");
  }
  if (typeof record.iv !== "string" || typeof record.ciphertext !== "string") {
    throw new Error("privacy: malformed App identity key ciphertext");
  }
  return {
    schemaVersion: 1,
    epochId: record.epochId,
    iv: record.iv,
    ciphertext: record.ciphertext,
  };
}

export function randomIdentityKey(): SaltBytes {
  return crypto.getRandomValues(new Uint8Array(MINTED_IDENTITY_KEY_BYTES)) as SaltBytes;
}

export async function wrapIdentityKey(input: {
  kekMaterial: string;
  identityKey: SaltBytes;
  epochId: string;
}): Promise<AppIdentityKeyRecord> {
  if (input.identityKey.length === 0) {
    throw new Error("privacy: empty App identity key");
  }
  if (input.epochId.length === 0 || input.epochId.includes(":")) {
    throw new Error("privacy: invalid identity epoch id");
  }
  const kek = await importKek(input.kekMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(IDENTITY_KEY_WRAP_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    kek,
    asArrayBuffer(input.identityKey),
  );
  return {
    schemaVersion: IDENTITY_KEY_WRAP_SCHEMA_VERSION,
    epochId: input.epochId,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function unwrapIdentityKey(input: {
  kekMaterial: string;
  record: AppIdentityKeyRecord;
}): Promise<SaltBytes> {
  if (input.record.schemaVersion !== IDENTITY_KEY_WRAP_SCHEMA_VERSION) {
    throw new Error("privacy: unknown App identity key record schema");
  }
  const kek = await importKek(input.kekMaterial);
  const iv = fromBase64(input.record.iv);
  if (iv.length !== IDENTITY_KEY_WRAP_IV_BYTES) {
    throw new Error("privacy: malformed App identity key IV");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asArrayBuffer(iv) },
      kek,
      asArrayBuffer(fromBase64(input.record.ciphertext)),
    );
    const identityKey = new Uint8Array(plaintext) as SaltBytes;
    if (identityKey.length === 0) {
      throw new Error("privacy: empty App identity key");
    }
    return identityKey;
  } catch (cause) {
    throw new Error("privacy: failed to unwrap App identity key", { cause });
  }
}
