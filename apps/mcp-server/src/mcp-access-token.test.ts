import { beforeAll, describe, expect, it } from "vitest";
import { makeHttpMcpAccessTokenVerifier } from "./mcp-access-token";

const ISSUER = "https://auth.splitch.test";
const AUDIENCE = "https://mcp.splitch.test/mcp";
const NOW = 1_800_000_000;

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

describe("MCP access-token verifier", () => {
  it("validates signature, type, issuer, expiry, audience, and scope shape", async () => {
    const verifier = makeHttpMcpAccessTokenVerifier({
      issuer: ISSUER,
      fetchJwks: async () => ({ keys: [{ ...publicJwk, kty: "RSA", kid: "test" }] }),
    });
    const validClaims = {
      typ: "access_token",
      sub: "user_mcp",
      iss: ISSUER,
      aud: AUDIENCE,
      exp: NOW + 60,
      scopes: ["app:app_local:admin"],
    };

    await expect(
      verifier.verify(`Bearer ${await sign(validClaims)}`, AUDIENCE, NOW),
    ).resolves.toEqual({ subject: "user_mcp", scopes: ["app:app_local:admin"] });

    for (const claims of [
      { ...validClaims, iss: "https://attacker.test" },
      { ...validClaims, aud: "https://api.splitch.test" },
      { ...validClaims, exp: NOW - 1 },
      { ...validClaims, scopes: [42] },
      { ...validClaims, scopes: [""] },
      { ...validClaims, scopes: Array.from({ length: 65 }, (_, index) => `scope:${index}`) },
      { ...validClaims, sub: "x".repeat(257) },
      { ...validClaims, typ: "identity_assertion" },
    ]) {
      await expect(
        verifier.verify(`Bearer ${await sign(claims)}`, AUDIENCE, NOW),
      ).resolves.toBeNull();
    }
  });

  it("rejects malformed and incorrectly signed credentials", async () => {
    const verifier = makeHttpMcpAccessTokenVerifier({
      issuer: ISSUER,
      fetchJwks: async () => ({ keys: [{ ...publicJwk, kty: "RSA", kid: "test" }] }),
    });
    await expect(verifier.verify("Bearer garbage", AUDIENCE, NOW)).resolves.toBeNull();
    const token = await sign({
      typ: "access_token",
      sub: "user_mcp",
      iss: ISSUER,
      aud: AUDIENCE,
      exp: NOW + 60,
      scopes: [],
    });
    await expect(verifier.verify(`Bearer ${token}broken`, AUDIENCE, NOW)).resolves.toBeNull();
  });
});

async function sign(claims: unknown): Promise<string> {
  const header = encode({ alg: "RS256", typ: "JWT", kid: "test" });
  const payload = encode(claims);
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

function encode(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
