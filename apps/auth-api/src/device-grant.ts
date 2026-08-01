import { OAuthError } from "./oauth-errors";

interface DeviceGrant {
  deviceCode: string;
  /** Null: a cold-start login with no App yet; the token mints unbound. */
  selectedAppSelector: string | null;
  expiresAt: number;
}

export async function sealDeviceGrant(grant: DeviceGrant, secret: string): Promise<string> {
  const payload = encode(JSON.stringify(grant));
  return `${payload}.${encodeBytes(await sign(payload, secret))}`;
}

export async function openDeviceGrant(
  value: string,
  secret: string,
  now: number,
): Promise<DeviceGrant> {
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra || !(await signatureValid(payload, signature, secret))) {
      throw new Error("invalid device grant signature");
    }
    const parsed = JSON.parse(decode(payload)) as Partial<DeviceGrant>;
    if (
      typeof parsed.deviceCode !== "string" ||
      (typeof parsed.selectedAppSelector !== "string" && parsed.selectedAppSelector !== null) ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= now
    ) {
      throw new Error("invalid device grant claims");
    }
    return parsed as DeviceGrant;
  } catch {
    throw new OAuthError("invalid_grant", "device grant is invalid or expired");
  }
}

async function sign(payload: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`splitch-device-grant:${secret}`) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload) as unknown as BufferSource,
  );
}

async function signatureValid(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const expected = new Uint8Array(await sign(payload, secret));
  const actual = decodeBytes(signature);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= (expected[index] as number) ^ (actual[index] as number);
  }
  return difference === 0;
}

function encode(value: string): string {
  return encodeBytes(new TextEncoder().encode(value));
}

function encodeBytes(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): string {
  return new TextDecoder().decode(decodeBytes(value));
}

function decodeBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
