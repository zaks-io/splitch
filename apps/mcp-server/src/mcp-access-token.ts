export interface McpAccessTokenActor {
  subject: string;
  scopes: string[];
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
      const key = selectKey(await fetchJwks(), parsed.header.kid);
      if (!key || !(await signatureValid(parsed, key))) return null;
      return actorFromClaims(parsed.payload, { issuer, expectedAudience, nowSeconds });
    },
  };
}

interface ParsedJwt {
  header: { alg?: unknown; kid?: string };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    return {
      header: decodeSegment(header),
      payload: decodeSegment(payload),
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
    !claims.scopes.every(
      (scope) => typeof scope === "string" && scope.length > 0 && scope.length <= 512,
    )
  ) {
    return null;
  }
  return { subject: claims.sub, scopes: claims.scopes as string[] };
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

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
