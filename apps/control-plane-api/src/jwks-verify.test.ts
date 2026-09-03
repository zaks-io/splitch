import { describe, expect, it, vi } from "vitest";
import { makeJwksVerifier } from "./jwks-verify";

describe("makeJwksVerifier", () => {
  it("returns null for malformed signature encoding without fetching JWKS", async () => {
    const fetchJwks = vi.fn(async () => {
      throw new Error("JWKS fetch must not run for a malformed signature");
    });
    const verifier = makeJwksVerifier({
      fetchJwks,
      issuer: "https://auth.splitch.test",
      controlPlaneAudience: "https://cp.splitch.test",
    });

    await expect(verifier.verify("eyJhbGciOiJSUzI1NiJ9.e30.%%%", 0)).resolves.toBeNull();
    expect(fetchJwks).not.toHaveBeenCalled();
  });
});
