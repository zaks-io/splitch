import { describe, expect, it, vi } from "vitest";
import { makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";

describe("makeJwksVerifier", () => {
  it.each([
    "%%%",
    "a+b",
    "a/b",
    "a b",
    "a",
  ])("returns null for malformed signature encoding %j without fetching JWKS", async (signature) => {
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
  });

  it("returns null for a validly signed null payload", async () => {
    const signer = await makeFixtureSigner();
    const verifier = makeJwksVerifier({
      fetchJwks: async () => signer.jwks,
      issuer: "https://auth.splitch.test",
      controlPlaneAudience: "https://cp.splitch.test",
    });

    await expect(verifier.verify(await signer.signPayload(null), 0)).resolves.toBeNull();
  });
});
