import type { AuthResolver } from "@splitch/worker-runtime";

interface VerifiedToken {
  sub: string;
  scopes: string[];
}

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
}

interface Jwks {
  keys: Jwk[];
}

type JwksFetcher = () => Promise<Jwks>;

interface JwksVerifier {
  verify(token: string, nowSeconds: number): Promise<VerifiedToken | null>;
}

interface SessionStore {
  isRevoked(sessionId: string): Promise<boolean>;
}

const BEARER_PREFIX = "Bearer ";
const REVOKED_PREFIX = "revoked:";
const APP_SCOPE = /^app:([^:]+):(owner|admin|member)$/;
const ORG_SCOPE = /^org:([^:]+):(owner|admin|member)$/;
const DEFAULT_JWKS_TIMEOUT_MS = 3_000;
const DEFAULT_JWKS_CACHE_TTL_MS = 5 * 60_000;

export function makeControlPlaneAuthResolver(deps: {
  verifier: JwksVerifier;
  sessions: SessionStore;
  now?: () => number;
}): AuthResolver {
  const nowSeconds = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);

  return async (request) => {
    const token = bearerToken(request.headers.get("authorization"));
    if (token === null) {
      return { ok: false, reason: "UNAUTHORIZED" };
    }

    const verified = await deps.verifier.verify(token, nowSeconds());
    if (verified === null) {
      return { ok: false, reason: "UNAUTHORIZED" };
    }
    if (await deps.sessions.isRevoked(verified.sub)) {
      return { ok: false, reason: "CREDENTIAL_REVOKED" };
    }

    return {
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: verified.sub,
        scopes: verified.scopes,
        orgId: soleId(idsInScopes(verified.scopes, ORG_SCOPE)),
        appId: soleId(idsInScopes(verified.scopes, APP_SCOPE)),
        environmentId: null,
      },
    };
  };
}

export function makeSessionStore(kv: KVNamespace | undefined): SessionStore {
  return {
    async isRevoked(sessionId) {
      if (kv === undefined) {
        throw new Error("analysis-api: SESSION_STORE binding is required for control-plane auth");
      }
      return (await kv.get(`${REVOKED_PREFIX}${sessionId}`)) !== null;
    },
  };
}

export function makeHttpJwksFetcher(
  jwksUri: string,
  opts: {
    fetchFn?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    cacheTtlMs?: number;
  } = {},
): JwksFetcher {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  let cached: { jwks: Jwks; expiresAtMs: number } | null = null;

  return async () => {
    const nowMs = now();
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.jwks;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(jwksUri, { signal: controller.signal });
    } catch (cause) {
      throw new Error(`analysis-api: JWKS fetch failed (${errorMessage(cause)})`);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`analysis-api: JWKS fetch failed (${res.status})`);
    }
    const jwks = (await res.json()) as Jwks;
    cached = { jwks, expiresAtMs: nowMs + cacheTtlMs };
    return jwks;
  };
}

export function makeJwksVerifier(opts: {
  fetchJwks: JwksFetcher;
  controlPlaneAudience: string;
  expectedIssuer: string;
}): JwksVerifier {
  return {
    async verify(token, nowSeconds) {
      const parsed = parseJwt(token);
      if (parsed === null) {
        return null;
      }
      if (!(await signatureValid(parsed, opts.fetchJwks))) {
        return null;
      }
      return actorFromClaims(
        parsed.payload,
        opts.controlPlaneAudience,
        opts.expectedIssuer,
        nowSeconds,
      );
    },
  };
}

function bearerToken(header: string | null): string | null {
  if (!header?.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? null : token;
}

function idsInScopes(scopes: readonly string[], pattern: RegExp): Set<string> {
  const ids = new Set<string>();
  for (const scope of scopes) {
    const match = pattern.exec(scope);
    if (match?.[1]) {
      ids.add(match[1]);
    }
  }
  return ids;
}

function soleId(ids: Set<string>): string | null {
  return ids.size === 1 ? ([...ids][0] as string) : null;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
}

interface ParsedJwt {
  header: JwtHeader;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerSeg, payloadSeg, sigSeg] = parts as [string, string, string];
  try {
    return {
      header: decodeSegment(headerSeg) as unknown as JwtHeader,
      payload: decodeSegment(payloadSeg),
      signingInput: `${headerSeg}.${payloadSeg}`,
      signature: sigSeg,
    };
  } catch {
    return null;
  }
}

async function signatureValid(parsed: ParsedJwt, fetchJwks: JwksFetcher): Promise<boolean> {
  if (parsed.header.alg !== "RS256") {
    return false;
  }
  const jwk = selectRsaKey(await fetchJwks(), parsed.header.kid);
  if (jwk === null) {
    return false;
  }
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    ),
    base64UrlToBytes(parsed.signature) as unknown as BufferSource,
    new TextEncoder().encode(parsed.signingInput) as unknown as BufferSource,
  );
}

function selectRsaKey(jwks: Jwks, kid: string | undefined): Jwk | null {
  const key = kid === undefined ? jwks.keys[0] : jwks.keys.find((item) => item.kid === kid);
  return key?.kty === "RSA" && key.n && key.e ? key : null;
}

function actorFromClaims(
  payload: Record<string, unknown>,
  controlPlaneAudience: string,
  expectedIssuer: string,
  nowSeconds: number,
): VerifiedToken | null {
  if (payload.iss !== expectedIssuer) {
    return null;
  }
  if (payload.aud !== controlPlaneAudience) {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds) {
    return null;
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return null;
  }
  return {
    sub: payload.sub,
    scopes: Array.isArray(payload.scopes) ? payload.scopes.filter(isString) : [],
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
