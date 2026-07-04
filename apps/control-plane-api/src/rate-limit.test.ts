import { describe, expect, it } from "vitest";
import { rateLimiterForTarget } from "./rate-limit";

describe("rateLimiterForTarget", () => {
  it.each(["local", "shared-preview"])("allows %s to exercise Control Plane routes", (target) => {
    expect(rateLimiterForTarget(target)(input())).toEqual({ limited: false });
  });

  it.each(["production", undefined])("fails closed for %s without a real limiter", (target) => {
    expect(() => rateLimiterForTarget(target)(input())).toThrow(
      "control-plane-api: rate-limit binding is not configured yet",
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
