const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EncryptedIntegrationSecret {
  ciphertext: string;
  fingerprint: string;
  keyVersion: string;
}

export async function encryptIntegrationSecret(
  secret: string,
  base64Key: string | undefined,
  keyVersion: string | undefined,
  keyName: string,
): Promise<EncryptedIntegrationSecret> {
  const rawKey = requiredKey(base64Key, keyName);
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(rawKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(secret),
  );
  return {
    ciphertext: `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`,
    fingerprint: await hmacHex(rawKey, secret),
    keyVersion: keyVersion ?? "v1",
  };
}

export async function decryptIntegrationSecret(
  ciphertext: string,
  base64Key: string | undefined,
  keyName: string,
): Promise<string> {
  const rawKey = requiredKey(base64Key, keyName);
  const [ivPart, encryptedPart] = ciphertext.split(".", 2);
  if (!ivPart || !encryptedPart) throw new Error("Integration secret ciphertext is malformed");
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(rawKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64Url(ivPart)) },
    key,
    asArrayBuffer(fromBase64Url(encryptedPart)),
  );
  return decoder.decode(decrypted);
}

export async function signIntegrationPayload(secret: string, value: string): Promise<string> {
  return hmacHex(encoder.encode(secret), value);
}

function requiredKey(value: string | undefined, keyName: string): Uint8Array {
  if (!value) throw new Error(`${keyName} is required`);
  const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (decoded.byteLength !== 32) throw new Error(`${keyName} must decode to exactly 32 bytes`);
  return decoded;
}

async function hmacHex(keyBytes: Uint8Array, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
