import { OAuthError } from "./oauth-errors";
import { accessTokenPrivateJwkFromSecret } from "./access-token-key";

/**
 * identity_assertion mint + /oauth2/token exchange.
 *
 * Door A returns an `identity_assertion` (the durable client-side artifact,
 * ADR-0022), which the agent presents at `/oauth2/token` for a short-lived
 * control-plane access token. No refresh token on the ID-JAG path. Both are
 * HMAC-SHA256-signed JWTs here (local fixture; production swaps the signer for
 * the real key).
 *
 * The two token classes are signed with SEPARATE secrets (`assertionSecret` vs
 * `accessSecret`) so an identity_assertion can NEVER verify as a control-plane
 * Bearer (type confusion): even if the typ/aud guards were bypassed, the access
 * verifier keys off a secret the assertion was not signed with. Both also carry
 * a `typ` discriminator and the access token binds `aud` to the control-plane
 * origin — defense in depth (access-control-matrix.md).
 */

const ASSERTION_TTL_SECONDS = 300; // assertion is exchanged immediately
const ACCESS_TOKEN_TTL_SECONDS = 3600; // control-plane token default 1h

interface AssertionClaims {
  typ: "identity_assertion";
  sub: string; // WorkOS user_id
  scopes: string[];
  iss: string;
  iat: number;
  exp: number;
}

type AccessTokenAuthDoor = "id_jag" | "anonymous" | "device_flow" | "client_credentials";

interface AccessTokenClaims {
  typ: "access_token";
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  scopes: string[];
  auth_door: AccessTokenAuthDoor;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signHmacJwt(claims: object, secret: string): Promise<string> {
  const signingInput = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment(claims)}`;
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(signingInput) as unknown as BufferSource,
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

async function rsaSigningKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signRs256Jwt(claims: object, secret: string): Promise<string | null> {
  const jwk = accessTokenPrivateJwkFromSecret(secret);
  if (!jwk) {
    return null;
  }
  const jwkRecord = jwk as Record<string, unknown>;
  const header = { alg: "RS256", typ: "JWT", kid: jwkRecord.kid };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await rsaSigningKey(jwk),
    new TextEncoder().encode(signingInput) as unknown as BufferSource,
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

async function signAccessJwt(claims: object, secret: string): Promise<string> {
  return (await signRs256Jwt(claims, secret)) ?? signHmacJwt(claims, secret);
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function verifyAndDecode(token: string, secret: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OAuthError("invalid_grant", "identity_assertion is malformed");
  }
  const [h, p, s] = parts as [string, string, string];
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    base64UrlToBytes(s) as unknown as BufferSource,
    new TextEncoder().encode(`${h}.${p}`) as unknown as BufferSource,
  );
  if (!ok) {
    throw new OAuthError("invalid_grant", "identity_assertion signature is invalid");
  }
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(p))) as Record<string, unknown>;
}

/** The verified claims of an identity_assertion (Door B claim reads these). */
interface AssertionIdentity {
  userId: string;
  scopes: string[];
}

export interface TokenSigner {
  mintIdentityAssertion(userId: string, scopes: string[], nowSeconds: number): Promise<string>;
  exchangeForAccessToken(assertion: string, nowSeconds: number): Promise<string>;
  /**
   * Verify a provisional identity_assertion and return its claims (the claim
   * ceremony needs the `sub` + pre-claim `scopes`, not an access token yet).
   * Throws `invalid_grant` on a bad/expired/non-assertion token (fail-loud).
   */
  verifyIdentityAssertion(assertion: string, nowSeconds: number): Promise<AssertionIdentity>;
  /**
   * Mint a control-plane access token directly for an already-resolved user with
   * the given scopes + auth_door (the claim ceremony issues the upgraded token
   * without a second assertion round-trip).
   */
  mintAccessToken(
    userId: string,
    scopes: string[],
    authDoor: AccessTokenClaims["auth_door"],
    nowSeconds: number,
  ): Promise<string>;
}

/**
 * Build the token signer bound to the two signing secrets + the issuer/audience
 * origins. The identity_assertion is signed with `assertionSecret`; the
 * control-plane access token with `accessSecret` (deliberately distinct — see the
 * type-confusion note above). `iss` is the auth-api origin; the access token `aud`
 * is the control-plane protected-resource origin so a downstream Worker can
 * assert it (matrix.md).
 */
export function makeTokenSigner(opts: {
  assertionSecret: string;
  accessSecret: string;
  issuer: string;
  controlPlaneAudience: string;
}): TokenSigner {
  return {
    async mintIdentityAssertion(userId, scopes, nowSeconds) {
      const claims: AssertionClaims = {
        typ: "identity_assertion",
        sub: userId,
        scopes,
        iss: opts.issuer,
        iat: nowSeconds,
        exp: nowSeconds + ASSERTION_TTL_SECONDS,
      };
      return signHmacJwt(claims, opts.assertionSecret);
    },

    async exchangeForAccessToken(assertion, nowSeconds) {
      const claims = await verifyAndDecode(assertion, opts.assertionSecret);
      if (claims.typ !== "identity_assertion" || typeof claims.sub !== "string") {
        throw new OAuthError("invalid_grant", "not a valid identity_assertion");
      }
      // exp is REQUIRED: a missing exp must not mean never-expires (fail-loud).
      if (typeof claims.exp !== "number" || claims.exp < nowSeconds) {
        throw new OAuthError("invalid_grant", "identity_assertion is missing exp or has expired");
      }
      const scopes = Array.isArray(claims.scopes) ? (claims.scopes as string[]) : [];
      const access: AccessTokenClaims = {
        typ: "access_token",
        sub: claims.sub,
        iss: opts.issuer,
        aud: opts.controlPlaneAudience,
        iat: nowSeconds,
        exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
        scopes,
        auth_door: "id_jag",
      };
      return signAccessJwt(access, opts.accessSecret);
    },

    async verifyIdentityAssertion(assertion, nowSeconds) {
      const claims = await verifyAndDecode(assertion, opts.assertionSecret);
      if (claims.typ !== "identity_assertion" || typeof claims.sub !== "string") {
        throw new OAuthError("invalid_grant", "not a valid identity_assertion");
      }
      if (typeof claims.exp !== "number" || claims.exp < nowSeconds) {
        throw new OAuthError("invalid_grant", "identity_assertion is missing exp or has expired");
      }
      return {
        userId: claims.sub,
        scopes: Array.isArray(claims.scopes) ? (claims.scopes as string[]) : [],
      };
    },

    async mintAccessToken(userId, scopes, authDoor, nowSeconds) {
      const access: AccessTokenClaims = {
        typ: "access_token",
        sub: userId,
        iss: opts.issuer,
        aud: opts.controlPlaneAudience,
        iat: nowSeconds,
        exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
        scopes,
        auth_door: authDoor,
      };
      return signAccessJwt(access, opts.accessSecret);
    },
  };
}
