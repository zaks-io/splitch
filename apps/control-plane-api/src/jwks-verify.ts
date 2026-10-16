import {
  type AccessTokenAuthorization,
  type AuthDoor,
  accessTokenAuthDoorFromClaim,
  accessTokenAuthorizationFromClaim,
  accessTokenIssuedAt,
  PERSONAL_ACCESS_TOKEN_STEP_UP_TTL_SECONDS,
} from "@splitch/contracts";
import { remoteJwksSignatureVerifier } from "@splitch/worker-runtime";

/**
 * Control-plane JWT verification against a JWKS (RS256, Web Crypto).
 *
 * The control-plane token is the short-lived bearer the auth-api mints
 * (access-control-matrix.md "Token validation": verify signature against the
 * issuer JWKS, assert `iss`, `typ`, `aud`, and `exp`). Scope derivation and
 * session revocation are separate concerns.
 *
 * The signature is the entire trust root, so a bad/absent/non-RS256 signature is
 * a loud failure, never a skipped check. `alg: none` and any non-RS256 alg are
 * rejected outright so an attacker-chosen alg is never honored.
 *
 * The JWKS fetcher is a port: production GETs the auth-api JWKS URI; tests inject
 * a fixture whose public key matches the fixture signer (no network, no real
 * auth-api key).
 */

interface VerifiedToken {
  /** Actor id (WorkOS user_id) for audit, from `sub`. */
  sub: string;
  /** Granted scopes (`app:{appId}:{role}` / `org:{orgId}:{role}`). */
  scopes: string[];
  /**
   * Which door minted the token, from `auth_door`. An unrecognized or missing
   * claim resolves to `"anonymous"`, the LEAST-privileged door: a token that
   * cannot prove which door it came through must not be treated as identified.
   */
  authDoor: AuthDoor;
  /** Structural read-only authority. Membership rows are never carried in the JWT. */
  authorization?: AccessTokenAuthorization;
  /** `iat`, compared against the subject's revocation time. */
  issuedAt?: number;
  patManagement?: { jti: string; expiresAt: number };
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

export interface Jwks {
  keys: Jwk[];
}

/** Port for fetching a JWKS document (real = fetch; tests inject a fixture). */
export type JwksFetcher = () => Promise<Jwks>;

/** Production fetcher: GET the auth-api JWKS URI and parse it. */
export function makeHttpJwksFetcher(jwksUri: string): JwksFetcher {
  return async () => {
    const res = await fetch(jwksUri);
    if (!res.ok) {
      throw new Error(`control-plane: JWKS fetch failed (${res.status}) for ${jwksUri}`);
    }
    return (await res.json()) as Jwks;
  };
}

export interface JwksVerifier {
  /**
   * Verify a compact JWT and return its actor claims, or `null` on ANY
   * verification failure (bad signature, issuer/type/audience mismatch, expired,
   * malformed). A null
   * is an authentication failure the resolver maps to UNAUTHORIZED; it never
   * throws for the ordinary bad-token case. A genuine fault in the fetcher
   * (e.g. JWKS unreachable) is allowed to throw — the guard maps it to 500.
   */
  verify(token: string, nowSeconds: number): Promise<VerifiedToken | null>;
}

/** Production verifier backed by jose's process-local remote JWKS cache. */
export function makeCachedJwksVerifier(options: {
  jwksUri: string;
  controlPlaneAudience: string;
}): JwksVerifier {
  const signatures = remoteJwksSignatureVerifier(options.jwksUri);
  const issuer = new URL(options.jwksUri).origin;
  return {
    async verify(token, nowSeconds) {
      const parsed = parseJwt(token);
      if (!parsed || !(await signatures.verify(token))) return null;
      return actorFromClaims(parsed.payload, issuer, options.controlPlaneAudience, nowSeconds);
    },
  };
}

function base64UrlToBytes(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(input) || input.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeSegment(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JWT segment is not a JSON object");
  }
  return value as Record<string, unknown>;
}

interface ParsedJwt {
  header: JwtHeader;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

/** Split + decode a compact JWS. Returns null for any malformed input. */
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
      signature: base64UrlToBytes(sigSeg),
    };
  } catch {
    return null;
  }
}

function selectRsaKey(jwks: Jwks, kid: string | undefined): Jwk | null {
  const key = kid ? jwks.keys.find((k) => k.kid === kid) : jwks.keys[0];
  if (key?.kty !== "RSA" || !key.n || !key.e) {
    return null;
  }
  return key;
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/** Verify the RS256 signature of a parsed JWT against the JWKS. */
async function signatureValid(parsed: ParsedJwt, fetchJwks: JwksFetcher): Promise<boolean> {
  // RS256 only. `none`/HS256/anything else is an attacker-chosen alg → reject.
  if (parsed.header.alg !== "RS256") {
    return false;
  }
  const jwk = selectRsaKey(await fetchJwks(), parsed.header.kid);
  if (!jwk) {
    return false;
  }
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    await importRsaKey(jwk),
    parsed.signature as unknown as BufferSource,
    new TextEncoder().encode(parsed.signingInput) as unknown as BufferSource,
  );
}

/** Assert issuer, token type, audience, expiry, and subject on a verified payload. */
function actorFromClaims(
  payload: Record<string, unknown>,
  issuer: string,
  controlPlaneAudience: string,
  nowSeconds: number,
): VerifiedToken | null {
  if (!validAccessTokenClaims(payload, issuer, controlPlaneAudience, nowSeconds)) return null;
  const scopes = Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [];
  const authorization = validAuthorization(payload.authorization, payload.scopes, scopes);
  if (authorization === null) return null;
  if (authorization === "pat-management" && !validPatManagementClaims(payload, nowSeconds)) {
    return null;
  }
  return {
    sub: payload.sub,
    scopes,
    authDoor: authDoorFromClaim(payload.auth_door),
    ...(authorization ? { authorization } : {}),
    ...accessTokenIssuedAt(payload),
    ...(authorization === "pat-management"
      ? { patManagement: { jti: payload.jti as string, expiresAt: payload.exp } }
      : {}),
  };
}

function validAccessTokenClaims(
  payload: Record<string, unknown>,
  issuer: string,
  audience: string,
  nowSeconds: number,
): payload is Record<string, unknown> & { sub: string; exp: number } {
  return (
    payload.iss === issuer &&
    payload.typ === "access_token" &&
    payload.aud === audience &&
    typeof payload.exp === "number" &&
    payload.exp >= nowSeconds &&
    typeof payload.sub === "string" &&
    payload.sub.length > 0
  );
}

function validPatManagementClaims(payload: Record<string, unknown>, nowSeconds: number): boolean {
  if (payload.auth_door !== "device_flow" || typeof payload.jti !== "string") return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.jti)) {
    return false;
  }
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return false;
  const issuedAt = payload.iat as number;
  const expiresAt = payload.exp as number;
  return (
    issuedAt <= nowSeconds &&
    expiresAt > nowSeconds &&
    expiresAt > issuedAt &&
    expiresAt - issuedAt <= PERSONAL_ACCESS_TOKEN_STEP_UP_TTL_SECONDS
  );
}

function validAuthorization(
  claim: unknown,
  scopeClaim: unknown,
  scopes: readonly string[],
): AccessTokenAuthorization | null | undefined {
  const authorization = accessTokenAuthorizationFromClaim(claim);
  if (claim !== undefined && authorization === undefined) return null;
  if (authorization && (!Array.isArray(scopeClaim) || scopes.length !== 0)) return null;
  return authorization;
}

/** Fail CLOSED: anything but a recognized door reads as the provisional one. */
function authDoorFromClaim(claim: unknown): AuthDoor {
  return accessTokenAuthDoorFromClaim(claim);
}

/**
 * Build the verifier bound to the control-plane audience + JWKS fetcher. Returns
 * null (not throw) for every attacker-controlled failure mode.
 */
export function makeJwksVerifier(opts: {
  fetchJwks: JwksFetcher;
  issuer: string;
  controlPlaneAudience: string;
}): JwksVerifier {
  return {
    async verify(token, nowSeconds) {
      const parsed = parseJwt(token);
      if (!parsed) {
        return null;
      }
      if (!(await signatureValid(parsed, opts.fetchJwks))) {
        return null;
      }
      return actorFromClaims(parsed.payload, opts.issuer, opts.controlPlaneAudience, nowSeconds);
    },
  };
}
