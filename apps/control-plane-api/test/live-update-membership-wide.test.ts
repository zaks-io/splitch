import { env } from "cloudflare:workers";
import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

describe("membership-wide live-update authorization", () => {
  it("fails loud when a wide principal has no live memberships", async () => {
    const onError = vi.fn();
    const app = createApp({
      authResolver: () => ({
        ok: true,
        principal: {
          kind: "control-plane-token",
          id: "user_live_updates_wide",
          scopes: [],
          orgId: null,
          appId: null,
          environmentId: null,
          authDoor: "device_flow",
          authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
        },
      }),
      rateLimiter: () => ({ limited: false }),
      repo: createRepository(env.DB),
      observability: { onError },
    });

    const response = await app.request("/apps/app_1/envs/env_1/live", {
      headers: { upgrade: "websocket" },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(onError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      cause: expect.objectContaining({
        message: "worker-runtime: membership-wide principal has no live memberships",
      }),
    });
  });

  it("rejects a wide principal without membership in the requested App", async () => {
    const app = createApp({
      authResolver: () => ({
        ok: true,
        principal: widePrincipal(),
      }),
      rateLimiter: () => ({ limited: false }),
      repo: createRepository(env.DB),
    });

    const response = await app.request("/apps/app_foreign/envs/env_foreign/live", {
      headers: { upgrade: "websocket" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a principal bound to a different Environment", async () => {
    const app = createApp({
      authResolver: () => ({
        ok: true,
        principal: {
          ...widePrincipal(),
          environmentId: "env_foreign",
        },
      }),
      rateLimiter: () => ({ limited: false }),
      repo: createRepository(env.DB),
    });

    const response = await app.request("/apps/app_own/envs/env_own/live", {
      headers: { upgrade: "websocket" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});

function widePrincipal() {
  return {
    kind: "control-plane-token" as const,
    id: "user_live_updates_wide",
    scopes: [],
    orgId: null,
    appId: null,
    environmentId: null,
    authDoor: "device_flow" as const,
    authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
    memberships: {
      organizations: [{ id: "org_own", role: "admin" as const }],
      apps: [{ id: "app_own", organizationId: "org_own", role: "admin" as const }],
    },
  };
}
