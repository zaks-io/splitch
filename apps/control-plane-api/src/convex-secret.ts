const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EncryptedSecret {
  ciphertext: string;
  fingerprint: string;
  keyVersion: string;
}

export async function encryptConvexSecret(
  secret: string,
  base64Key: string | undefined,
  keyVersion: string | undefined,
): Promise<EncryptedSecret> {
  const rawKey = requiredKey(base64Key);
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

export async function decryptConvexSecret(
  ciphertext: string,
  base64Key: string | undefined,
): Promise<string> {
  const rawKey = requiredKey(base64Key);
  const [ivPart, encryptedPart] = ciphertext.split(".", 2);
  if (!ivPart || !encryptedPart) throw new Error("Convex webhook ciphertext is malformed");
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

export async function signConvexWebhook(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  return hmacHex(encoder.encode(secret), `${timestamp}.${body}`);
}

function requiredKey(value: string | undefined): Uint8Array {
  if (!value) throw new Error("CONVEX_WEBHOOK_KEK is required");
  const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (decoded.byteLength !== 32)
    throw new Error("CONVEX_WEBHOOK_KEK must decode to exactly 32 bytes");
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
