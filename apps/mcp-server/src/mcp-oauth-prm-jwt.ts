import { NOW_SECONDS, actor } from "./mcp-oauth-prm-harness";

/**
 * JWT minting for the MCP OAuth tests: the stub auth-api signs with these, and
 * the malformed-shape sweep uses them to build tokens the verifier must reject.
 */

export function actorClaims(issuer: string) {
  return { typ: "access_token", sub: actor.subject, scopes: actor.scopes, iss: issuer };
}

export async function signAccessToken(key: CryptoKey, claims: unknown): Promise<string> {
  const header = encodeJwtSegment({ alg: "RS256", typ: "JWT", kid: "fake-auth" });
  const payload = encodeJwtSegment(claims);
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

export function encodeJwtSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function malformedShapeTokens(): string[] {
  const header = encodeJwtSegment({ alg: "RS256", typ: "JWT", kid: "fake-auth" });
  const payload = encodeJwtSegment({
    ...actorClaims("https://auth.splitch.test"),
    aud: "https://mcp.splitch.test/mcp",
    exp: NOW_SECONDS + 60,
  });
  const invalidJson = base64Url(new TextEncoder().encode("{"));
  const nonRecords: unknown[] = [null, true, 42, "jwt", []];

  return [
    ...nonRecords.map((value) => `${encodeJwtSegment(value)}.${payload}.signature`),
    ...nonRecords.map((value) => `${header}.${encodeJwtSegment(value)}.signature`),
    `%%%.${payload}.signature`,
    `${header}.%%%.signature`,
    `${invalidJson}.${payload}.signature`,
    `${header}.${invalidJson}.signature`,
  ];
}
