import { MCP_DELEGATION_HEADER, type McpDelegationReplayGuard } from "./index";

export const SECRET = "d".repeat(32);
export const OTHER_SECRET = "e".repeat(32);

export function resultsRequest(method: "GET" | "POST"): Request {
  return new Request(
    "https://control-plane.internal/apps/app_one/envs/env_one/experiments/exp_one/results",
    { method },
  );
}

export async function resignCredential(
  credential: string,
  patch: Record<string, unknown>,
): Promise<string> {
  const [payload] = credential.split(".") as [string];
  const decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as Record<
    string,
    unknown
  >;
  const changedPayload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ ...decoded, ...patch })),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(changedPayload));
  return `${changedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export function withCredential(request: Request, credential: string): Request {
  const copy = new Request(request);
  copy.headers.set(MCP_DELEGATION_HEADER, credential);
  return copy;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function memoryReplayGuard(): McpDelegationReplayGuard {
  const seen = new Set<string>();
  return {
    async claim(jti) {
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    },
  };
}
