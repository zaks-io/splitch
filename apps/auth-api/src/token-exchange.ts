import {
  type AccessTokenAuthorization,
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
} from "@splitch/contracts";
import { accessTokenPrivateJwkFromSecret, accessTokenSigningKey } from "./access-token-key";
import { OAuthError } from "./oauth-errors";

/**
 * identity_assertion mint + /oauth2/token exchange.
 *
 * Door A returns an `identity_assertion` (the durable client-side artifact,
 * ADR-0022), which the agent presents at `/oauth2/token` for a short-lived
 * resource-bound access token. No refresh token on the ID-JAG path. Both are
 * HMAC-SHA256 signs identity assertions and isolated unit-test access tokens.
 * The real Auth Worker issues RS256 access tokens on every target, backed by
 * the Auth API JWKS route so downstream Workers share one verification contract.
 *
 * The two token classes are signed with SEPARATE secrets (`assertionSecret` vs
 * `accessSecret`) so an identity_assertion can NEVER verify as a control-plane
 * Bearer (type confusion): even if the typ/aud guards were bypassed, the access
 * verifier keys off a secret the assertion was not signed with. Both also carry
 * a `typ` discriminator and the access token binds `aud` to an explicitly
 * allowed protected resource — defense in depth (access-control-matrix.md).
 */

const ASSERTION_TTL_SECONDS = 15 * 60; // aligns with the Door B claim ceremony
const ACCESS_TOKEN_TTL_SECONDS = 3600; // control-plane token default 1h

interface AssertionClaims {
  typ: "identity_assertion";
  sub: string; // WorkOS user_id
  scopes: string[];
  iss: string;
  iat: number;
  exp: number;
  auth_door: AssertionAuthDoor;
  demo_expires_at?: string;
}

type AssertionAuthDoor = "id_jag" | "anonymous";
type AccessTokenAuthDoor = "id_jag" | "anonymous" | "device_flow" | "client_credentials";

export type AccessTokenTrustContract = "local-hs256" | "rs256-jwks";

interface AccessTokenClaims {
  typ: "access_token";
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  scopes: string[];
  auth_door: AccessTokenAuthDoor;
  demo_expires_at?: string;
  authorization?: AccessTokenAuthorization;
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
    await accessTokenSigningKey(jwk),
    new TextEncoder().encode(signingInput) as unknown as BufferSource,
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

async function signAccessJwt(
  claims: object,
  secret: string,
  contract: AccessTokenTrustContract,
): Promise<string> {
  if (contract === "rs256-jwks") {
    const jwt = await signRs256Jwt(claims, secret);
    if (!jwt) {
      throw new Error("ACCESS_TOKEN_SECRET must be an RSA private JWK for hosted access tokens");
    }
    return jwt;
  }
  return signHmacJwt(claims, secret);
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

function assertionAuthDoor(claims: Record<string, unknown>): AssertionAuthDoor {
  if (claims.auth_door !== "anonymous" && claims.auth_door !== "id_jag") {
    throw new OAuthError("invalid_grant", "identity_assertion auth door is invalid");
  }
  return claims.auth_door;
}

function demoExpiresAtClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface ExchangedAssertion {
  sub: string;
  scopes: string[];
  authDoor: AssertionAuthDoor;
  demoExpiresAt?: string;
}

function exchangedAssertionClaims(
  claims: Record<string, unknown>,
  nowSeconds: number,
): ExchangedAssertion {
  if (claims.typ !== "identity_assertion" || typeof claims.sub !== "string") {
    throw new OAuthError("invalid_grant", "not a valid identity_assertion");
  }
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds) {
    throw new OAuthError("invalid_grant", "identity_assertion is missing exp or has expired");
  }
  const demoExpiresAt = demoExpiresAtClaim(claims.demo_expires_at);
  return {
    sub: claims.sub,
    scopes: Array.isArray(claims.scopes) ? (claims.scopes as string[]) : [],
    authDoor: assertionAuthDoor(claims),
    ...(demoExpiresAt ? { demoExpiresAt } : {}),
  };
}

function accessTokenClaimsForExchange(
  exchanged: ExchangedAssertion,
  options: {
    issuer: string;
    audience: string;
    nowSeconds: number;
    authorization?: AccessTokenAuthorization;
  },
): AccessTokenClaims {
  return {
    typ: "access_token",
    sub: exchanged.sub,
    iss: options.issuer,
    aud: options.audience,
    iat: options.nowSeconds,
    exp: options.nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
    scopes: options.authorization ? [] : exchanged.scopes,
    auth_door: exchanged.authDoor,
    ...(exchanged.demoExpiresAt ? { demo_expires_at: exchanged.demoExpiresAt } : {}),
    ...(options.authorization ? { authorization: options.authorization } : {}),
  };
}

async function verifyAndDecode(token: string, secret: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OAuthError("invalid_grant", "identity_assertion is malformed");
  }
  const [h, p, s] = parts as [string, string, string];
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(s);
  } catch {
    throw new OAuthError("invalid_grant", "identity_assertion signature is malformed");
  }
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature as unknown as BufferSource,
    new TextEncoder().encode(`${h}.${p}`) as unknown as BufferSource,
  );
  if (!ok) {
    throw new OAuthError("invalid_grant", "identity_assertion signature is invalid");
  }
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p)));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("identity_assertion payload is not a JSON object");
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new OAuthError("invalid_grant", "identity_assertion payload is malformed");
  }
}

/** The verified claims of an identity_assertion (Door B claim reads these). */
interface AssertionIdentity {
  userId: string;
  scopes: string[];
}

export interface TokenSigner {
  mintIdentityAssertion(
    userId: string,
    scopes: string[],
    authDoor: AssertionAuthDoor,
    nowSeconds: number,
    demoExpiresAt?: string,
  ): Promise<string>;
  exchangeForAccessToken(
    assertion: string,
    nowSeconds: number,
    audience?: string,
    authorization?: AccessTokenAuthorization,
  ): Promise<string>;
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
    audience?: string,
    authorization?: AccessTokenAuthorization,
  ): Promise<string>;
}

/**
 * Build the token signer bound to the two signing secrets + the issuer/audience
 * origins. The identity_assertion is signed with `assertionSecret`; the
 * access token with `accessSecret` (deliberately distinct — see the type-confusion
 * note above). `iss` is the auth-api origin; callers select an already-approved
 * protected-resource audience when minting.
 */
export function makeTokenSigner(opts: {
  assertionSecret: string;
  accessSecret: string;
  accessTokenTrustContract?: AccessTokenTrustContract;
  issuer: string;
  controlPlaneAudience: string;
}): TokenSigner {
  const accessTokenTrustContract = opts.accessTokenTrustContract ?? "local-hs256";
  return {
    async mintIdentityAssertion(userId, scopes, authDoor, nowSeconds, demoExpiresAt) {
      const claims: AssertionClaims = {
        typ: "identity_assertion",
        sub: userId,
        scopes,
        iss: opts.issuer,
        iat: nowSeconds,
        exp: nowSeconds + ASSERTION_TTL_SECONDS,
        auth_door: authDoor,
        ...(demoExpiresAtClaim(demoExpiresAt) ? { demo_expires_at: demoExpiresAt } : {}),
      };
      return signHmacJwt(claims, opts.assertionSecret);
    },

    async exchangeForAccessToken(
      assertion,
      nowSeconds,
      audience = opts.controlPlaneAudience,
      authorization,
    ) {
      const claims = await verifyAndDecode(assertion, opts.assertionSecret);
      const exchanged = exchangedAssertionClaims(claims, nowSeconds);
      const access = accessTokenClaimsForExchange(exchanged, {
        issuer: opts.issuer,
        audience,
        nowSeconds,
        ...(authorization ? { authorization } : {}),
      });
      return signAccessJwt(access, opts.accessSecret, accessTokenTrustContract);
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

    async mintAccessToken(
      userId,
      scopes,
      authDoor,
      nowSeconds,
      audience = opts.controlPlaneAudience,
      authorization,
    ) {
      if (authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION && scopes.length !== 0) {
        throw new Error("membership-wide read tokens cannot carry selector scopes");
      }
      const access: AccessTokenClaims = {
        typ: "access_token",
        sub: userId,
        iss: opts.issuer,
        aud: audience,
        iat: nowSeconds,
        exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
        scopes,
        auth_door: authDoor,
        ...(authorization ? { authorization } : {}),
      };
      return signAccessJwt(access, opts.accessSecret, accessTokenTrustContract);
    },
  };
}
