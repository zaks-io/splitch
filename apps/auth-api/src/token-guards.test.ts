import { describe, expect, it } from "vitest";
import { verifyAccessToken } from "./access-token";
import { makeTokenSigner } from "./token-exchange";

/**
 * Focused guards on the access-token verifier (H1/H2): exp is REQUIRED, typ must
 * be access_token, aud must bind to the control-plane audience, and the verifier
 * keys off the ACCESS secret. We hand-craft HMAC tokens here so we can omit/forge
 * individual claims the high-level signer would never emit.
 */

const ACCESS_SECRET = "guard-access-secret";
const CP_AUDIENCE = "https://cp.splitch.test";
const NOW = 1_780_000_000;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function seg(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function sign(claims: Record<string, unknown>, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const input = `${seg({ alg: "HS256", typ: "JWT" })}.${seg(claims)}`;
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input) as unknown as BufferSource,
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function privateRsaJwkSecret(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ ...jwk, kid: "test-access-key", alg: "RS256", use: "sig" });
}

const opts = { accessSecret: ACCESS_SECRET, controlPlaneAudience: CP_AUDIENCE };

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    typ: "access_token",
    sub: "user_x",
    aud: CP_AUDIENCE,
    exp: NOW + 3600,
    scopes: [],
    ...overrides,
  };
}

describe("verifyAccessToken guards", () => {
  it("accepts a well-formed access token (control)", async () => {
    const token = await sign(valid(), ACCESS_SECRET);
    expect(await verifyAccessToken(`Bearer ${token}`, opts, NOW)).not.toBeNull();
  });

  it("accepts an RS256 access token when ACCESS_TOKEN_SECRET is an RSA private JWK", async () => {
    const accessSecret = await privateRsaJwkSecret();
    const signer = makeTokenSigner({
      assertionSecret: "test-assertion-secret",
      accessSecret,
      accessTokenTrustContract: "rs256-jwks",
      issuer: "https://auth.splitch.test",
      controlPlaneAudience: CP_AUDIENCE,
    });
    const token = await signer.mintAccessToken(
      "user_shared_preview_smoke",
      ["app:smoke-auth-missing-app:member"],
      "client_credentials",
      NOW,
    );

    const actor = await verifyAccessToken(
      `Bearer ${token}`,
      { accessSecret, controlPlaneAudience: CP_AUDIENCE },
      NOW,
    );

    expect(actor).toMatchObject({
      userId: "user_shared_preview_smoke",
      scopes: ["app:smoke-auth-missing-app:member"],
    });
  });

  it("fails closed when hosted RS256/JWKS mode has a symmetric access secret", async () => {
    const signer = makeTokenSigner({
      assertionSecret: "test-assertion-secret",
      accessSecret: ACCESS_SECRET,
      accessTokenTrustContract: "rs256-jwks",
      issuer: "https://auth.splitch.test",
      controlPlaneAudience: CP_AUDIENCE,
    });

    await expect(
      signer.mintAccessToken(
        "user_shared_preview_smoke",
        ["app:smoke-auth-missing-app:member"],
        "client_credentials",
        NOW,
      ),
    ).rejects.toThrow("ACCESS_TOKEN_SECRET must be an RSA private JWK");
  });

  it("returns null when ACCESS_TOKEN_SECRET contains malformed JWK JSON", async () => {
    const token = await sign(valid(), ACCESS_SECRET);

    await expect(
      verifyAccessToken(
        `Bearer ${token}`,
        { accessSecret: "{malformed", controlPlaneAudience: CP_AUDIENCE },
        NOW,
      ),
    ).resolves.toBeNull();
  });

  it("H2: rejects a token with NO exp (missing exp is not never-expires)", async () => {
    const noExp = valid();
    delete noExp.exp;
    const token = await sign(noExp, ACCESS_SECRET);
    expect(await verifyAccessToken(`Bearer ${token}`, opts, NOW)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await sign(valid({ exp: NOW - 1 }), ACCESS_SECRET);
    expect(await verifyAccessToken(`Bearer ${token}`, opts, NOW)).toBeNull();
  });

  it("H1: rejects typ !== access_token (e.g. an identity_assertion)", async () => {
    const token = await sign(valid({ typ: "identity_assertion" }), ACCESS_SECRET);
    expect(await verifyAccessToken(`Bearer ${token}`, opts, NOW)).toBeNull();
  });

  it("H1: rejects a mismatched aud", async () => {
    const token = await sign(valid({ aud: "https://evil.test" }), ACCESS_SECRET);
    expect(await verifyAccessToken(`Bearer ${token}`, opts, NOW)).toBeNull();
  });

  it("rejects a token signed with the assertion secret (separate-key defense)", async () => {
    const token = await sign(valid(), "the-assertion-secret-not-access");
    expect(await verifyAccessToken(`Bearer ${token}`, opts, NOW)).toBeNull();
  });
});
