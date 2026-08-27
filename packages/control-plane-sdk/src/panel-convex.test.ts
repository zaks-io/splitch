import { describe, expect, it, vi } from "vitest";
import { createPanelConvexClient } from "./panel-convex";

const SCOPE = { appId: "app_1", environmentId: "env_prod" };
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

function stubFetch(response: Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INSTALLATION = {
  installationId: INSTALLATION_ID,
  appId: SCOPE.appId,
  environmentId: SCOPE.environmentId,
  environmentVersion: 43,
  status: "active" as const,
  callbackUrl: "https://example.convex.site/splitch/config-changed",
  lastDeliveredVersion: 41,
  lastDeliveredAt: "2026-08-26T00:00:00.000Z",
  pendingCount: 1,
  oldestPendingAgeMs: 5000,
  terminalCount: 0,
  latestDeliveryError: null,
};

describe("panel Convex client", () => {
  it("lists installations from the Environment-scoped path", async () => {
    const fetch = stubFetch(
      json({ items: [INSTALLATION], readLimit: 200, readTruncated: false, cursor: null }),
    );
    const client = createPanelConvexClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    const result = await client.list(SCOPE);

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://control-plane.internal/apps/app_1/envs/env_prod/integrations/convex/installations",
    );
    expect(result.ok && result.data.items[0]?.lastDeliveredVersion).toBe(41);
  });

  it("reads a 204 revoke as the success it is", async () => {
    const fetch = stubFetch(new Response(null, { status: 204 }));
    const client = createPanelConvexClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    const result = await client.revoke({ ...SCOPE, installationId: INSTALLATION_ID });

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `https://control-plane.internal/apps/app_1/envs/env_prod/integrations/convex/installations/${INSTALLATION_ID}`,
    );
    expect((fetch.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ ok: true, data: { revoked: true }, status: 204 });
  });

  it("surfaces a refusal verbatim instead of throwing", async () => {
    const fetch = stubFetch(
      json({ code: "FORBIDDEN", message: "App admin role required", details: {} }, 403),
    );
    const client = createPanelConvexClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    const result = await client.revoke({ ...SCOPE, installationId: INSTALLATION_ID });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe("App admin role required");
  });
});
