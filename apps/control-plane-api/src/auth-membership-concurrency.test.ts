import { describe, expect, it, vi } from "vitest";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import type { JwksVerifier } from "./jwks-verify";

describe("bearer authority hot reads", () => {
  it("starts membership KV resolution before session revocation settles", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions = { isRevoked: vi.fn(async () => gate.then(() => false)) };
    const resolve = vi.fn(async () => gate.then(() => memberships()));
    const resolver = makeControlPlaneAuthResolver({
      verifier: {
        verify: async () => ({
          sub: "user_concurrent_cache",
          scopes: ["app:app_concurrent_cache:member"],
          authDoor: "id_jag",
        }),
      } as JwksVerifier,
      sessions,
      membershipAccess: { authorize: async () => true, resolve, resolveForRequest: resolve },
    });

    const pending = resolver(
      new Request("https://control-plane.test/apps/app_concurrent_cache", {
        headers: { authorization: "Bearer valid" },
      }),
    );
    await vi.waitFor(() => {
      expect(sessions.isRevoked).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledOnce();
    });
    release?.();

    await expect(pending).resolves.toMatchObject({ ok: true });
  });
});

function memberships() {
  return {
    organizations: [{ id: "org_concurrent_cache", role: "member" as const }],
    apps: [
      {
        id: "app_concurrent_cache",
        organizationId: "org_concurrent_cache",
        role: "member" as const,
      },
    ],
  };
}
