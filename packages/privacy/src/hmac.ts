/**
 * WebCrypto HMAC-SHA256 helpers shared by Targeting Key hashing and App salt
 * derivation. The Worker edge exposes subtle, not node:crypto.
 */

import type { SaltBytes } from "./salt-store";

const HMAC_PARAMS = { name: "HMAC", hash: "SHA-256" } as const;

export async function hmacSha256(key: SaltBytes, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, HMAC_PARAMS, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

export function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function hmacSha256Hex(key: SaltBytes, message: string): Promise<string> {
  return toHex(await hmacSha256(key, message));
}

export function utf8Bytes(value: string): SaltBytes {
  return new TextEncoder().encode(value) as SaltBytes;
}
