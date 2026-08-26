import type { HandlerArgs } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { makeConvexExposuresHandler } from "./convex-exposures";

describe("Cloudflare server Exposure verification", () => {
  it("never falls back to the Convex resolver", async () => {
    const convexResolve = vi.fn();
    const handler = makeConvexExposuresHandler({
      integrationKind: "cloudflare",
      convexConfigurationResolver: { resolve: convexResolve },
    } as unknown as Parameters<typeof makeConvexExposuresHandler>[0]);

    const response = await handler(requestArgs());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "cloudflare installation verification is unavailable",
    });
    expect(convexResolve).not.toHaveBeenCalled();
  });
});

function requestArgs(): HandlerArgs<unknown> {
  return {
    input: {},
    principal: {
      kind: "api-key",
      id: "api_key:test",
      scopes: ["data-plane:evaluate"],
      orgId: "org_1",
      appId: "app_1",
      environmentId: "env_1",
      authDoor: null,
    },
    requestId: "request_1",
    request: new Request("https://edge.splitch.dev/api/integrations/cloudflare/exposures"),
  };
}
