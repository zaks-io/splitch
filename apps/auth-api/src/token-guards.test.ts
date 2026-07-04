import { describe, expect, it } from "vitest";
import { verifyAccessToken } from "./access-token";

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
