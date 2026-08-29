import { env } from "cloudflare:workers";
import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("membership-wide live-update authorization", () => {
  it("fails loud when a wide principal has no live memberships", async () => {
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
    });

    const response = await app.request("/apps/app_1/envs/env_1/live", {
      headers: { upgrade: "websocket" },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});
