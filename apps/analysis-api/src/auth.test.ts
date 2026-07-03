import { describe, expect, it } from "vitest";
import { makeHttpJwksFetcher, makeJwksVerifier } from "./auth.js";

const AUDIENCE = "https://cp.splitch.test";
const ISSUER = "https://auth.splitch.test";
const NOW_SECONDS = 1_783_000_000;
const KID = "fixture-analysis-key";

describe("analysis control-plane JWT verifier", () => {
  it("requires the expected auth-api issuer", async () => {
    const signer = await makeFixtureSigner();
    const verifier = makeJwksVerifier({
      fetchJwks: async () => signer.jwks,
      controlPlaneAudience: AUDIENCE,
      expectedIssuer: ISSUER,
    });

    const valid = await verifier.verify(
      await signer.sign(validClaims({ iss: ISSUER })),
      NOW_SECONDS,
    );
    const wrongIssuer = await verifier.verify(
      await signer.sign(validClaims({ iss: "https://evil.example" })),
      NOW_SECONDS,
    );

    expect(valid).toMatchObject({ sub: "user_1", scopes: ["app:app_1:admin"] });
    expect(wrongIssuer).toBeNull();
  });

  it("caches bounded JWKS fetches until the configured TTL expires", async () => {
    const signer = await makeFixtureSigner();
    let now = 1_000;
    let fetches = 0;
    const fetchJwks = makeHttpJwksFetcher(`${ISSUER}/.well-known/jwks.json`, {
      cacheTtlMs: 1_000,
      fetchFn: async () => {
        fetches += 1;
        return Response.json(signer.jwks);
      },
      now: () => now,
      timeoutMs: 100,
    });
    const verifier = makeJwksVerifier({
      fetchJwks,
      controlPlaneAudience: AUDIENCE,
      expectedIssuer: ISSUER,
    });
    const token = await signer.sign(validClaims());

    await verifier.verify(token, NOW_SECONDS);
    await verifier.verify(token, NOW_SECONDS);
    now = 2_100;
    await verifier.verify(token, NOW_SECONDS);

    expect(fetches).toBe(2);
  });

  it("fails JWKS fetches fast when the upstream does not respond", async () => {
    const fetchJwks = makeHttpJwksFetcher(`${ISSUER}/.well-known/jwks.json`, {
      fetchFn: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      timeoutMs: 1,
    });

    await expect(fetchJwks()).rejects.toThrow(/JWKS fetch failed/);
  });
});

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: "user_1",
    iss: ISSUER,
    aud: AUDIENCE,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 3_600,
    scopes: ["app:app_1:admin"],
    ...overrides,
  };
}

interface FixtureSigner {
  jwks: { keys: { kty: string; kid: string; n: string; e: string }[] };
  sign(claims: Record<string, unknown>): Promise<string>;
}

async function makeFixtureSigner(): Promise<FixtureSigner> {
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
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as {
    kty: string;
    n: string;
    e: string;
  };

  return {
    jwks: { keys: [{ kty: publicJwk.kty, kid: KID, n: publicJwk.n, e: publicJwk.e }] },
    async sign(claims) {
      const signingInput = `${encodeSegment({ alg: "RS256", typ: "JWT", kid: KID })}.${encodeSegment(claims)}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(signingInput) as unknown as BufferSource,
      );
      return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
    },
  };
}

function encodeSegment(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
