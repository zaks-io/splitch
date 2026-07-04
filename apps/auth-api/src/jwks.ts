import { OAuthError } from "./oauth-errors";

/**
 * JWT decode + JWKS signature verification (Web Crypto, RS256).
 *
 * WHY hand-rolled and not a library: no `jose` is in the dependency set and the
 * Worker runtime exposes WebCrypto natively. The surface here is deliberately
 * narrow — decode the compact JWT, fetch the issuer's JWKS, and ACTUALLY verify
 * the RSA signature over `header.payload`. A bad signature is a loud
 * `invalid_token`, never a skipped check (the signature is the whole trust root).
 */

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface DecodedJwt {
  header: JwtHeader;
  payload: Record<string, unknown>;
  /** The `header.payload` bytes the signature covers. */
  signingInput: string;
  /** The decoded signature bytes. */
  signature: Uint8Array;
}

interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
}

/** A JWKS document: `{ keys: [...] }`. */
export interface Jwks {
  keys: Jwk[];
}

/** Port for fetching a JWKS document by URL (real = fetch; tests inject a fake). */
export type JwksFetcher = (jwksUri: string) => Promise<Jwks>;

/** The production fetcher: GET the JWKS URI and parse it as JSON. */
export const fetchJwks: JwksFetcher = async (jwksUri) => {
  const res = await fetch(jwksUri);
  if (!res.ok) {
    throw new OAuthError("invalid_token", `JWKS fetch failed (${res.status}) for ${jwksUri}`);
  }
  return (await res.json()) as Jwks;
};

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

function decodeJsonSegment(segment: string): Record<string, unknown> {
  const text = new TextDecoder().decode(base64UrlToBytes(segment));
  return JSON.parse(text) as Record<string, unknown>;
}

/** Decode a compact JWS without verifying — header/payload only. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OAuthError("invalid_token", "JWT is not a well-formed compact JWS");
  }
  const [headerSeg, payloadSeg, sigSeg] = parts as [string, string, string];
  let header: JwtHeader;
  let payload: Record<string, unknown>;
  try {
    header = decodeJsonSegment(headerSeg) as unknown as JwtHeader;
    payload = decodeJsonSegment(payloadSeg);
  } catch {
    throw new OAuthError("invalid_token", "JWT header/payload is not valid base64url JSON");
  }
  return {
    header,
    payload,
    signingInput: `${headerSeg}.${payloadSeg}`,
    signature: base64UrlToBytes(sigSeg),
  };
}

function selectKey(jwks: Jwks, kid: string | undefined): Jwk {
  const key = kid ? jwks.keys.find((k) => k.kid === kid) : jwks.keys[0];
  if (!key || key.kty !== "RSA" || !key.n || !key.e) {
    throw new OAuthError("invalid_token", "no matching RSA JWK for the token's kid");
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

/**
 * Verify the JWT signature against the issuer's JWKS. Only RS256 is accepted;
 * any other `alg` (including `none`) is a loud failure — an attacker-chosen alg
 * is never silently honored. A failed verification throws `invalid_token`.
 */
export async function verifySignature(decoded: DecodedJwt, jwks: Jwks): Promise<void> {
  if (decoded.header.alg !== "RS256") {
    throw new OAuthError(
      "invalid_token",
      `unsupported JWT alg "${decoded.header.alg}" (RS256 only)`,
    );
  }
  const key = await importRsaKey(selectKey(jwks, decoded.header.kid));
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decoded.signature as unknown as BufferSource,
    new TextEncoder().encode(decoded.signingInput) as unknown as BufferSource,
  );
  if (!ok) {
    throw new OAuthError("invalid_token", "JWT signature verification failed");
  }
}
