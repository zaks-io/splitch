import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFixtureSigner } from "./fixture-signer";
import { makeCachedJwksVerifier, makeJwksVerifier } from "./jwks-verify";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("makeJwksVerifier", () => {
  it.each(["%%%", "a+b", "a/b", "a b", "a"])(
    "returns null for malformed signature encoding %j without fetching JWKS",
    async (signature) => {
      const fetchJwks = vi.fn(async () => {
        throw new Error("JWKS fetch must not run for a malformed signature");
      });
      const verifier = makeJwksVerifier({
        fetchJwks,
        issuer: "https://auth.splitch.test",
        controlPlaneAudience: "https://cp.splitch.test",
      });

      await expect(verifier.verify(`eyJhbGciOiJSUzI1NiJ9.e30.${signature}`, 0)).resolves.toBeNull();
      expect(fetchJwks).not.toHaveBeenCalled();
    },
  );

  it("returns null for a validly signed null payload", async () => {
    const signer = await makeFixtureSigner();
    const verifier = makeJwksVerifier({
      fetchJwks: async () => signer.jwks,
      issuer: "https://auth.splitch.test",
      controlPlaneAudience: "https://cp.splitch.test",
    });

    await expect(verifier.verify(await signer.signPayload(null), 0)).resolves.toBeNull();
  });

  it("rejects non-base64url signatures before the production verifier fetches JWKS", async () => {
    const signer = await makeFixtureSigner();
    const jwksUri = `https://auth-${crypto.randomUUID()}.splitch.test/.well-known/jwks.json`;
    const fetchJwks = vi.fn(async () => Response.json(signer.jwks));
    vi.stubGlobal("fetch", fetchJwks);
    const verifier = makeCachedJwksVerifier({
      jwksUri,
      controlPlaneAudience: "https://cp.splitch.test",
    });
    const token = await signer.sign({
      iss: new URL(jwksUri).origin,
      aud: "https://cp.splitch.test",
      sub: "user_123",
      exp: 1_000,
      scopes: [],
    });
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const malformedTokens = [
      `${header}.${payload}.${signature.slice(0, 4)} ${signature.slice(4)}`,
      `${header}.${payload}.${signature}==`,
    ];

    for (const malformedToken of malformedTokens) {
      await expect(verifier.verify(malformedToken, 0)).resolves.toBeNull();
    }
    expect(fetchJwks).not.toHaveBeenCalled();
  });
});
