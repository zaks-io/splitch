/**
 * Control-plane JWT verification against a JWKS (RS256, Web Crypto).
 *
 * The control-plane token is the short-lived bearer the auth-api mints
 * (access-control-matrix.md "Token validation": verify signature against the
 * issuer JWKS, assert `aud`, assert `exp`). This module owns ONLY signature +
 * aud + exp. Scope derivation and session revocation are separate concerns.
 *
 * The signature is the entire trust root, so a bad/absent/non-RS256 signature is
 * a loud failure, never a skipped check. `alg: none` and any non-RS256 alg are
 * rejected outright so an attacker-chosen alg is never honored.
 *
 * The JWKS fetcher is a port: production GETs the auth-api JWKS URI; tests inject
 * a fixture whose public key matches the fixture signer (no network, no real
 * WorkOS — that wiring is HUMAN-SETUP S41).
 */

interface VerifiedToken {
  /** Actor id (WorkOS user_id) for audit, from `sub`. */
  sub: string;
  /** Granted scopes (`app:{appId}:{role}` / `org:{orgId}:{role}`). */
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
   * verification failure (bad signature, wrong aud, expired, malformed). A null
   * is an authentication failure the resolver maps to UNAUTHORIZED; it never
   * throws for the ordinary bad-token case. A genuine fault in the fetcher
   * (e.g. JWKS unreachable) is allowed to throw — the guard maps it to 500.
   */
  verify(token: string, nowSeconds: number): Promise<VerifiedToken | null>;
}

function base64UrlToBytes(input: string): Uint8Array {
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
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
}

interface ParsedJwt {
  header: JwtHeader;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
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
      signature: sigSeg,
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
    base64UrlToBytes(parsed.signature) as unknown as BufferSource,
    new TextEncoder().encode(parsed.signingInput) as unknown as BufferSource,
  );
}

/** Assert aud + exp + sub on a signature-verified payload, returning the actor. */
function actorFromClaims(
  payload: Record<string, unknown>,
  controlPlaneAudience: string,
  nowSeconds: number,
): VerifiedToken | null {
  // aud must bind to this control-plane resource (matrix.md step 2).
  if (payload.aud !== controlPlaneAudience) {
    return null;
  }
  // exp is REQUIRED: a missing exp must not read as never-expires (fail-loud).
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds) {
    return null;
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return null;
  }
  return {
    sub: payload.sub,
    scopes: Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [],
  };
}

/**
 * Build the verifier bound to the control-plane audience + JWKS fetcher. Returns
 * null (not throw) for every attacker-controlled failure mode.
 */
export function makeJwksVerifier(opts: {
  fetchJwks: JwksFetcher;
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
      return actorFromClaims(parsed.payload, opts.controlPlaneAudience, nowSeconds);
    },
  };
}
