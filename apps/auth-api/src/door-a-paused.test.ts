import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { type AppDeps, createApp } from "./app";
import type { TokenSigner } from "./token-exchange";

describe("Door A: paused", () => {
  it("rejects id_jag without invoking verification or signing", async () => {
    const fetchJwks = vi.fn();
    const getTrustedIdpByIssuer = vi.fn();
    const resolveOrCreateUser = vi.fn();
    const mintIdentityAssertion = vi.fn();
    const tokenSigner = {
      mintIdentityAssertion,
      exchangeForAccessToken: vi.fn(),
      verifyIdentityAssertion: vi.fn(),
      mintAccessToken: vi.fn(),
    } as unknown as TokenSigner;
    const repo = { privacy: { getTrustedIdpByIssuer } } as unknown as Repository;
    const app = createApp({
      repo,
      accessSecret: "test-access-secret",
      controlPlaneAudience: "https://cp.splitch.test",
      now: () => 1_780_000_000_000,
      idJag: {
        repo,
        jtiCache: {} as AppDeps["idJag"]["jtiCache"],
        workos: { resolveOrCreateUser } as unknown as AppDeps["idJag"]["workos"],
        fetchJwks,
        authApiOrigin: "https://auth.splitch.test",
        now: () => 1_780_000_000_000,
      },
      tokenSigner,
      register: {} as AppDeps["register"],
      claim: {} as AppDeps["claim"],
      deviceFlow: {} as AppDeps["deviceFlow"],
      deviceRefreshSessions: {} as AppDeps["deviceRefreshSessions"],
      sessionStore: {} as AppDeps["sessionStore"],
      revocations: {} as AppDeps["revocations"],
    });

    const response = await app.request("/agent/identity", {
      method: "POST",
      body: JSON.stringify({
        id_jag: "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwczovL2lkcC50ZXN0In0.signature",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      error_description: "ID-JAG authentication is paused",
    });
    expect(getTrustedIdpByIssuer).not.toHaveBeenCalled();
    expect(fetchJwks).not.toHaveBeenCalled();
    expect(resolveOrCreateUser).not.toHaveBeenCalled();
    expect(mintIdentityAssertion).not.toHaveBeenCalled();
  });
});
