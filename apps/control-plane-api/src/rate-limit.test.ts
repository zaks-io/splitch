import { describe, expect, it, vi } from "vitest";
import { rateLimiterForTarget } from "./rate-limit";

describe("rateLimiterForTarget", () => {
  it.each(["local", "shared-preview"])("allows %s to exercise Control Plane routes", (target) => {
    expect(rateLimiterForTarget(target, undefined)(input())).toEqual({ limited: false });
  });

  it.each(["production", undefined])("fails closed for %s without the binding", (target) => {
    expect(() => rateLimiterForTarget(target, undefined)(input())).toThrow(
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
});

function input() {
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
    },
  };
}
