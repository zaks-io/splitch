import { type AuthDoor, AuthDoorSchema } from "@splitch/contracts";

export interface McpAccessTokenActor {
  subject: string;
  scopes: string[];
  /**
   * Which door minted the token. Defaults to the LEAST-privileged door when the
   * claim is missing or unrecognized: an unidentifiable token must not be
   * treated as identified downstream.
   */
  authDoor: AuthDoor;
  demoExpiresAt?: string;
}

interface Jwks {
  keys: Array<{ kty: string; kid?: string; n?: string; e?: string }>;
}

export interface McpAccessTokenVerifier {
  verify(
    authorization: string | null,
    expectedAudience: string,
    nowSeconds: number,
  ): Promise<McpAccessTokenActor | null>;
}

export function makeHttpMcpAccessTokenVerifier(options: {
  issuer: string;
  fetchJwks?: () => Promise<Jwks>;
}): McpAccessTokenVerifier {
  const issuer = new URL(options.issuer).origin;
  const fetchJwks =
    options.fetchJwks ??
    (async () => {
      const response = await fetch(`${issuer}/.well-known/jwks.json`);
      if (!response.ok) {
        throw new Error(`mcp-server: JWKS fetch failed (${response.status})`);
      }
      return (await response.json()) as Jwks;
    });

  return {
    async verify(authorization, expectedAudience, nowSeconds) {
      const token = bearerToken(authorization);
      if (!token) return null;
      const parsed = parseJwt(token);
      if (parsed?.header.alg !== "RS256") return null;
      const key = selectKey(
        await fetchJwks(),
        typeof parsed.header.kid === "string" ? parsed.header.kid : undefined,
      );
      if (!key || !(await safeSignatureValid(parsed, key))) return null;
      return actorFromClaims(parsed.payload, { issuer, expectedAudience, nowSeconds });
    },
  };
}

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const decodedHeader = decodeSegment(header);
    const decodedPayload = decodeSegment(payload);
    if (!isPlainRecord(decodedHeader) || !isPlainRecord(decodedPayload)) return null;
    return {
      header: decodedHeader,
      payload: decodedPayload,
      signingInput: `${header}.${payload}`,
      signature,
    };
  } catch {
    return null;
  }
}

function actorFromClaims(
  claims: Record<string, unknown>,
  options: { issuer: string; expectedAudience: string; nowSeconds: number },
): McpAccessTokenActor | null {
  if (
    claims.typ !== "access_token" ||
    claims.iss !== options.issuer ||
    claims.aud !== options.expectedAudience ||
    typeof claims.exp !== "number" ||
    claims.exp <= options.nowSeconds ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 256 ||
    !Array.isArray(claims.scopes) ||
    claims.scopes.length > 64 ||
    !claims.scopes.every(isCanonicalHeldScope)
  ) {
    return null;
  }
  // `null` here is a forged door/demo-expiry pairing, not a missing optional
  // field: reject the token rather than fall back to a default door.
  const transport = transportFromClaims(claims);
  if (!transport) return null;
  return {
    subject: claims.sub,
    scopes: claims.scopes as string[],
    ...transport,
  };
}

/** Returns null ONLY for a claim combination no real door mints (a forgery). */
function transportFromClaims(
  claims: Record<string, unknown>,
): Pick<McpAccessTokenActor, "authDoor" | "demoExpiresAt"> | null {
  const parsed = AuthDoorSchema.safeParse(claims.auth_door);
  const authDoor = parsed.success ? parsed.data : "anonymous";
  const demoExpiresAt =
    typeof claims.demo_expires_at === "string" && claims.demo_expires_at.length > 0
      ? claims.demo_expires_at
      : undefined;
  // Only the anonymous door issues demo-expiring tokens; the pairing is a forgery
  // signal, so reject rather than pick one field to believe.
  if (authDoor !== "anonymous" && demoExpiresAt) return null;
  return {
    authDoor,
    ...(demoExpiresAt ? { demoExpiresAt } : {}),
  };
}

function isCanonicalHeldScope(scope: unknown): scope is string {
  if (typeof scope !== "string" || scope.length === 0 || scope.length > 512) return false;
  const segments = scope.split(":");
  if (segments.length !== 3) return false;
  const [kind, id, role] = segments;
  return (
    (kind === "org" || kind === "app") &&
    id !== "" &&
    (role === "owner" || role === "admin" || role === "member")
  );
}

function bearerToken(header: string | null): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function selectKey(jwks: Jwks, kid: string | undefined) {
  const key = kid ? jwks.keys.find((candidate) => candidate.kid === kid) : jwks.keys[0];
  return key?.kty === "RSA" && key.n && key.e ? key : null;
}

async function signatureValid(
  parsed: ParsedJwt,
  key: { kty: string; kid?: string; n?: string; e?: string },
): Promise<boolean> {
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlToBytes(parsed.signature) as unknown as BufferSource,
    new TextEncoder().encode(parsed.signingInput) as unknown as BufferSource,
  );
}

async function safeSignatureValid(
  parsed: ParsedJwt,
  key: { kty: string; kid?: string; n?: string; e?: string },
): Promise<boolean> {
  try {
    return await signatureValid(parsed, key);
  } catch {
    return false;
  }
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
