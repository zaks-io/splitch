import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFixtureKeypair, signIdJag } from "./test-fixtures";
import { makeWorkOsAccessTokenVerifier } from "./workos-access-token";

const NOW = 1_780_000_000;

describe("WorkOS consent access-token verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires a valid RS256 signature and the configured issuer, client, subject, and expiry", async () => {
    const keypair = await makeFixtureKeypair();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(keypair.jwks)),
    );
    const verifier = makeWorkOsAccessTokenVerifier({
      jwksUri: "https://workos.test/jwks",
      issuer: "https://workos.test",
      clientId: "client_123",
    });
    const token = await signIdJag(keypair.privateKey, {
      sub: "user_existing",
      iss: "https://workos.test",
      client_id: "client_123",
      exp: NOW + 60,
    });

    await expect(verifier.verify(token, NOW)).resolves.toEqual({ userId: "user_existing" });
  });

  it.each([
    { iss: "https://other.test" },
    { client_id: "other-client" },
    { sub: "" },
    { exp: NOW },
  ])("rejects a token with an invalid claim", async (override: Record<string, unknown>) => {
    const keypair = await makeFixtureKeypair();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(keypair.jwks)),
    );
    const verifier = makeWorkOsAccessTokenVerifier({
      jwksUri: "https://workos.test/jwks",
      issuer: "https://workos.test",
      clientId: "client_123",
    });
    const token = await signIdJag(keypair.privateKey, {
      sub: "user_existing",
      iss: "https://workos.test",
      client_id: "client_123",
      exp: NOW + 60,
      ...override,
    });

    await expect(verifier.verify(token, NOW)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects a validly shaped token signed by another key", async () => {
    const keypair = await makeFixtureKeypair();
    const other = await makeFixtureKeypair();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(keypair.jwks)),
    );
    const verifier = makeWorkOsAccessTokenVerifier({
      jwksUri: "https://workos.test/jwks",
      issuer: "https://workos.test",
      clientId: "client_123",
    });
    const token = await signIdJag(other.privateKey, {
      sub: "user_existing",
      iss: "https://workos.test",
      client_id: "client_123",
      exp: NOW + 60,
    });

    await expect(verifier.verify(token, NOW)).rejects.toMatchObject({ code: "invalid_token" });
  });
});
