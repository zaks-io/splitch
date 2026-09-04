import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
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
const ASSERTION_SECRET = "guard-assertion-secret";
const ISSUER = "https://auth.splitch.test";
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

async function sign(claims: unknown, secret: string): Promise<string> {
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

describe("identity assertion guards", () => {
  it("rejects a signed null payload as invalid_grant", async () => {
    const signer = makeTokenSigner({
      assertionSecret: ASSERTION_SECRET,
      accessSecret: ACCESS_SECRET,
      issuer: ISSUER,
      controlPlaneAudience: CP_AUDIENCE,
    });
    const assertion = await sign(null, ASSERTION_SECRET);

    await expect(signer.exchangeForAccessToken(assertion, NOW)).rejects.toMatchObject({
      code: "invalid_grant",
      status: 400,
    });
    await expect(signer.verifyIdentityAssertion(assertion, NOW)).rejects.toMatchObject({
      code: "invalid_grant",
      status: 400,
    });
  });
});

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

const opts = { accessSecret: ACCESS_SECRET, issuer: ISSUER, controlPlaneAudience: CP_AUDIENCE };

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    typ: "access_token",
    sub: "user_x",
    iss: ISSUER,
    aud: CP_AUDIENCE,
    exp: NOW + 3600,
    scopes: [],
    ...overrides,
  };
}

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("missing JWT payload");
  const padded = payload
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

describe("membership-wide read access token claims", () => {
  it("mints a structural membership-wide read claim with no selector scopes", async () => {
    const signer = makeTokenSigner({
      assertionSecret: "test-assertion-secret",
      accessSecret: ACCESS_SECRET,
      issuer: ISSUER,
      controlPlaneAudience: CP_AUDIENCE,
    });

    const token = await signer.mintAccessToken(
      "user_wide_read",
      [],
      "device_flow",
      NOW,
      CP_AUDIENCE,
      MEMBERSHIP_WIDE_READ_AUTHORIZATION,
    );

    expect(decodePayload(token)).toMatchObject({
      sub: "user_wide_read",
      scopes: [],
      authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
    });
  });

  it("refuses to combine membership-wide read authority with selector scopes", async () => {
    const signer = makeTokenSigner({
      assertionSecret: "test-assertion-secret",
      accessSecret: ACCESS_SECRET,
      issuer: ISSUER,
      controlPlaneAudience: CP_AUDIENCE,
    });

    await expect(
      signer.mintAccessToken(
        "user_wide_read",
        ["app:app_demo:member"],
        "device_flow",
        NOW,
        CP_AUDIENCE,
        MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      ),
    ).rejects.toThrow("membership-wide read tokens cannot carry selector scopes");
  });
});

describe("verifyAccessToken guards", () => {
  it("binds the anonymous Door B audit identity through assertion exchange", async () => {
    const signer = makeTokenSigner({
      assertionSecret: "test-assertion-secret",
      accessSecret: ACCESS_SECRET,
      issuer: "https://auth.splitch.test",
      controlPlaneAudience: CP_AUDIENCE,
    });
    const assertion = await signer.mintIdentityAssertion(
      "user_anonymous",
      ["app:app_demo:member"],
      "anonymous",
      NOW,
    );
    const token = await signer.exchangeForAccessToken(assertion, NOW);

    expect(decodePayload(token)).toMatchObject({
      sub: "user_anonymous",
      scopes: ["app:app_demo:member"],
      auth_door: "anonymous",
    });
  });

  it("accepts canonical scopes without changing the verified actor", async () => {
    const claims = valid({
      scopes: ["app:app_demo:admin", "org:org_demo:member"],
    });
    const token = await sign(claims, ACCESS_SECRET);

    await expect(verifyAccessToken(`Bearer ${token}`, opts, NOW)).resolves.toEqual({
      userId: "user_x",
      scopes: ["app:app_demo:admin", "org:org_demo:member"],
      expiresAt: NOW + 3600,
    });
  });

  it("keeps selector-bound token claims unchanged", async () => {
    const signer = makeTokenSigner({
      assertionSecret: "test-assertion-secret",
      accessSecret: ACCESS_SECRET,
      issuer: ISSUER,
      controlPlaneAudience: CP_AUDIENCE,
    });
    const token = await signer.mintAccessToken(
      "user_selector_bound",
      ["app:app_demo:member"],
      "device_flow",
      NOW,
    );

    expect(decodePayload(token)).toEqual({
      typ: "access_token",
      sub: "user_selector_bound",
      iss: ISSUER,
      aud: CP_AUDIENCE,
      iat: NOW,
      exp: NOW + 3600,
      scopes: ["app:app_demo:member"],
      auth_door: "device_flow",
    });
  });
});

describe("verifyAccessToken malformed claim guards", () => {
  it.each([
    ["missing", undefined],
    ["a non-array", "app:app_demo:member"],
    ["an object", [{}]],
    ["a number", [42]],
    ["an empty string", [""]],
    ["an unknown value", ["bogus"]],
    ["an empty identifier", ["app::member"]],
    ["an unknown role", ["app:app_demo:viewer"]],
    ["more than 64 entries", Array.from({ length: 65 }, () => "app:app_demo:member")],
    ["an entry longer than 512 characters", [`app:${"x".repeat(507)}:member`]],
  ])("rejects scopes containing %s", async (_case, scopes) => {
    const token = await sign(valid({ scopes }), ACCESS_SECRET);

    await expect(verifyAccessToken(`Bearer ${token}`, opts, NOW)).resolves.toBeNull();
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
      { accessSecret, issuer: ISSUER, controlPlaneAudience: CP_AUDIENCE },
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
        { accessSecret: "{malformed", issuer: ISSUER, controlPlaneAudience: CP_AUDIENCE },
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

  it.each([
    ["missing", undefined],
    ["mismatched", "https://attacker.test"],
  ])("rejects a token with a %s issuer", async (_case, issuer) => {
    const token = await sign(valid({ iss: issuer }), ACCESS_SECRET);

    await expect(verifyAccessToken(`Bearer ${token}`, opts, NOW)).resolves.toBeNull();
  });

  it("fails loud when the verifier issuer is missing", async () => {
    const token = await sign(valid(), ACCESS_SECRET);

    await expect(
      verifyAccessToken(`Bearer ${token}`, { ...opts, issuer: "" }, NOW),
    ).rejects.toThrow("auth-api access-token issuer is required");
  });

  it("rejects a token signed with the assertion secret (separate-key defense)", async () => {
    const token = await sign(valid(), "the-assertion-secret-not-access");
    expect(await verifyAccessToken(`Bearer ${token}`, opts, NOW)).toBeNull();
  });
});
