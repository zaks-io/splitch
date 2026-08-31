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
  it("validates AuthKit tokens and resolves authorization from live Splitch membership", async () => {
    const verifier = makeHttpMcpAccessTokenVerifier({
      issuer: "https://splitch.authkit.test",
      profile: "authkit",
      fetchJwks: async () => ({ keys: [{ ...publicJwk, kty: "RSA", kid: "test" }] }),
    });
    const claims = {
      sub: "user_workos",
      iss: "https://splitch.authkit.test",
      aud: AUDIENCE,
      exp: NOW + 60,
      scope: "openid profile email offline_access",
    };
    const token = await sign(claims);

    await expect(verifier.verify(`Bearer ${token}`, AUDIENCE, NOW)).resolves.toEqual({
      subject: "user_workos",
      scopes: [],
      liveMembership: true,
      authDoor: "device_flow",
    });

    await expect(
      verifier.verify(`Bearer ${token}`, "https://other-resource.test", NOW),
    ).resolves.toBeNull();
    await expect(
      verifier.verify(`Bearer ${await sign({ ...claims, nbf: NOW + 1 })}`, AUDIENCE, NOW),
    ).resolves.toBeNull();
  });

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

    // No `auth_door` claim, so the door resolves fail-closed to the
    // least-privileged one rather than being treated as identified.
    await expect(
      verifier.verify(`Bearer ${await sign(validClaims)}`, AUDIENCE, NOW),
    ).resolves.toEqual({
      subject: "user_mcp",
      scopes: ["app:app_local:admin"],
      authDoor: "anonymous",
    });

    await expect(
      verifier.verify(
        `Bearer ${await sign({
          ...validClaims,
          auth_door: "anonymous",
          demo_expires_at: "2026-07-22T00:00:00.000Z",
        })}`,
        AUDIENCE,
        NOW,
      ),
    ).resolves.toEqual({
      subject: "user_mcp",
      scopes: ["app:app_local:admin"],
      authDoor: "anonymous",
      demoExpiresAt: "2026-07-22T00:00:00.000Z",
    });

    for (const claims of [
      { ...validClaims, iss: "https://attacker.test" },
      { ...validClaims, aud: "https://api.splitch.test" },
      { ...validClaims, exp: NOW - 1 },
      { ...validClaims, nbf: NOW + 1 },
      { ...validClaims, nbf: "not-a-number" },
      { ...validClaims, scopes: [42] },
      { ...validClaims, scopes: [""] },
      { ...validClaims, scopes: ["bogus"] },
      { ...validClaims, scopes: ["org::owner"] },
      { ...validClaims, scopes: ["app::member"] },
      { ...validClaims, scopes: ["org:org_local:owner:extra"] },
      { ...validClaims, scopes: ["app:app_local:viewer"] },
      {
        ...validClaims,
        scopes: Array.from({ length: 65 }, () => "app:app_local:member"),
      },
      { ...validClaims, scopes: [`app:${"x".repeat(507)}:member`] },
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

    const [header, payload] = token.split(".") as [string, string];
    await expect(
      verifier.verify(`Bearer ${header}.${payload}.%%%`, AUDIENCE, NOW),
    ).resolves.toBeNull();
  });

  it("rejects non-record and undecodable JWT headers and payloads before JWKS lookup", async () => {
    let jwksCalls = 0;
    const verifier = makeHttpMcpAccessTokenVerifier({
      issuer: ISSUER,
      fetchJwks: async () => {
        jwksCalls += 1;
        return { keys: [] };
      },
    });

    for (const token of malformedShapeTokens()) {
      await expect(verifier.verify(`Bearer ${token}`, AUDIENCE, NOW)).resolves.toBeNull();
    }
    expect(jwksCalls).toBe(0);
  });

  it("contains key-import failures but leaves JWKS availability fail-loud", async () => {
    const malformedKey = makeHttpMcpAccessTokenVerifier({
      issuer: ISSUER,
      fetchJwks: async () => ({ keys: [{ kty: "RSA", kid: "test", n: "%%%", e: "AQAB" }] }),
    });
    const token = await sign({
      typ: "access_token",
      sub: "user_mcp",
      iss: ISSUER,
      aud: AUDIENCE,
      exp: NOW + 60,
      scopes: [],
    });

    await expect(malformedKey.verify(`Bearer ${token}`, AUDIENCE, NOW)).resolves.toBeNull();

    const unavailable = makeHttpMcpAccessTokenVerifier({
      issuer: ISSUER,
      fetchJwks: async () => {
        throw new Error("JWKS unavailable");
      },
    });
    await expect(unavailable.verify(`Bearer ${token}`, AUDIENCE, NOW)).rejects.toThrow(
      "JWKS unavailable",
    );
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

function malformedShapeTokens(): string[] {
  const header = encode({ alg: "RS256", typ: "JWT", kid: "test" });
  const payload = encode({
    typ: "access_token",
    sub: "user_mcp",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: NOW + 60,
    scopes: [],
  });
  const invalidJson = base64Url(new TextEncoder().encode("{"));
  const nonRecords: unknown[] = [null, true, 42, "jwt", []];

  return [
    ...nonRecords.map((value) => `${encode(value)}.${payload}.signature`),
    ...nonRecords.map((value) => `${header}.${encode(value)}.signature`),
    `%%%.${payload}.signature`,
    `${header}.%%%.signature`,
    `${invalidJson}.${payload}.signature`,
    `${header}.${invalidJson}.signature`,
  ];
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
