import { getRoute } from "@splitch/contracts";
import { createRegistrar } from "@splitch/worker-runtime";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { rateLimiterForTarget } from "./rate-limit";

describe("rateLimiterForTarget", () => {
  it.each(["local", "shared-preview"])("allows %s to exercise Control Plane routes", (target) => {
    expect(rateLimiterForTarget(target, undefined)(input())).toEqual({ limited: false });
  });

  it.each(["production", undefined])("fails closed for %s without the binding", async (target) => {
    await expect(rateLimiterForTarget(target, undefined)(input())).rejects.toThrow(
      "control-plane-api: actor rate-limit binding is not configured",
    );
  });

  it("keys production decisions by authenticated actor", async () => {
    const limit = vi.fn(async () => ({ success: true }));

    await expect(rateLimiterForTarget("production", { limit })(input())).resolves.toEqual({
      limited: false,
    });
    expect(limit).toHaveBeenCalledWith({ key: "control-plane-token:user_smoke" });
  });

  it("returns a bounded retry window when the actor is limited", async () => {
    const limit = vi.fn(async () => ({ success: false }));

    await expect(rateLimiterForTarget("production", { limit })(input())).resolves.toEqual({
      limited: true,
      retryAfterMs: 60_000,
    });
  });

  it("propagates binding failures so the runtime fails closed", async () => {
    const limit = vi.fn(async () => {
      throw new Error("binding unavailable");
    });

    await expect(rateLimiterForTarget("production", { limit })(input())).rejects.toThrow(
      "binding unavailable",
    );
  });

  it.each([
    "api-key",
    "client-key",
  ] as const)("inherits the surface Worker's %s class instead of throwing (SPL-449)", async (rateLimitClass) => {
    const limit = vi.fn(async () => ({ success: true }));

    await expect(
      rateLimiterForTarget("production", { limit })(input({ class: rateLimitClass })),
    ).resolves.toEqual({ limited: false });
    expect(limit).not.toHaveBeenCalled();
  });

  it("still fails closed on an unknown guarded class", async () => {
    await expect(
      rateLimiterForTarget("production", { limit: vi.fn() })(
        input({ class: "anonymous-registration" }),
      ),
    ).rejects.toThrow("control-plane-api: unsupported rate-limit class anonymous-registration");
  });

  it("lets a production Convex install through the registrar (SPL-449)", async () => {
    const route = getRoute("convex_installations_create");
    if (!route) throw new Error("convex_installations_create is not registered");
    const limit = vi.fn(async () => ({ success: true }));
    const app = new Hono();
    createRegistrar({
      authResolvers: {
        "api-key": () => ({
          ok: true,
          principal: {
            kind: "api-key",
            id: "key_fresh",
            scopes: ["data-plane:evaluate", "data-plane:write"],
            orgId: "org_1",
            appId: "app_1",
            environmentId: "env_1",
            authDoor: null,
          },
        }),
      },
      rateLimiter: rateLimiterForTarget("production", { limit }),
    }).mount(app, route, () =>
      Response.json({
        installationId: "11111111-1111-4111-8111-111111111111",
        appId: "app_1",
        environmentId: "env_1",
        environmentVersion: 1,
        status: "active",
      }),
    );

    const response = await app.request("/api/integrations/convex/installations", {
      method: "POST",
      headers: { authorization: "Bearer fresh", "content-type": "application/json" },
      body: JSON.stringify({
        installationId: "11111111-1111-4111-8111-111111111111",
        callbackUrl: "https://customer.convex.site/integrations/splitch/configuration",
        webhookSecret: "A".repeat(50),
      }),
    });

    expect(response.status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      installationId: "11111111-1111-4111-8111-111111111111",
      appId: "app_1",
      environmentId: "env_1",
      environmentVersion: 1,
      status: "active",
    });
  });
});

function input(
  overrides: Partial<{
    class: "control-plane-actor" | "api-key" | "client-key" | "anonymous-registration";
  }> = {},
) {
  return {
    class: "control-plane-actor" as const,
    request: new Request("https://api.preview.splitch.dev/apps/app"),
    principal: {
      kind: "control-plane-token" as const,
      id: "user_smoke",
      scopes: [],
      orgId: null,
      appId: null,
      environmentId: null,
      authDoor: null,
    },
    ...overrides,
  };
}
