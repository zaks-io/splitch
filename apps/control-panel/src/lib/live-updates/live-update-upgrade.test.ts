import { describe, expect, it, vi } from "vitest";
import {
  handleLiveUpdateUpgrade,
  type LiveUpdateUpgradeDeps,
} from "#lib/live-updates/live-update-upgrade";

const scope = {
  orgSlug: "acme",
  appSlug: "checkout",
  env: "dev",
  orgId: "org_1",
  appId: "app_1",
  environmentId: "env_dev",
};
const context = {
  version: 1 as const,
  sessionTokenHash: "a".repeat(64),
  userId: "user_1",
  orgId: scope.orgId,
  appId: scope.appId,
  environmentId: scope.environmentId,
  expiresAt: 1_800_000_000,
};

describe("same-origin live update upgrade", () => {
  it("forwards only server-derived scope metadata to the right Durable Object", async () => {
    const connect: LiveUpdateUpgradeDeps["connect"] = vi.fn(
      async () => new Response(null, { status: 200 }),
    );
    const authorize = vi.fn(async () => ({ ok: true as const, scope, context }));

    const response = await handleLiveUpdateUpgrade(
      request("https://panel.test/acme/checkout/dev/live", { cookie: "__session=opaque" }),
      deps({ authorize, connect }),
    );

    expect(response?.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      orgSlug: "acme",
      appSlug: "checkout",
      env: "dev",
    });
    expect(connect).toHaveBeenCalledWith(
      { appId: "app_1", environmentId: "env_dev" },
      expect.objectContaining({ url: "https://live-update.internal/connect" }),
    );
    const forwarded = vi.mocked(connect).mock.calls[0]?.[1];
    expect(forwarded).toBeInstanceOf(Request);
    if (!forwarded) throw new Error("expected forwarded Durable Object request");
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("sec-websocket-protocol")).toBeNull();
    expect(JSON.parse(forwarded.headers.get("x-splitch-live-update-context") ?? "null")).toEqual(
      context,
    );
  });

  it.each([
    [
      "missing Origin",
      new Request("https://panel.test/acme/checkout/dev/live", {
        headers: { upgrade: "websocket" },
      }),
    ],
    [
      "wrong Origin",
      request("https://panel.test/acme/checkout/dev/live", { origin: "https://evil.test" }),
    ],
    [
      "subprotocol credential channel",
      request("https://panel.test/acme/checkout/dev/live", {
        "sec-websocket-protocol": "Bearer secret",
      }),
    ],
    ["credential query string", request("https://panel.test/acme/checkout/dev/live?token=secret")],
  ])("rejects %s before authorization or Durable Object attachment", async (_name, upgrade) => {
    const authorize = vi.fn();
    const connect = vi.fn();

    const response = await handleLiveUpdateUpgrade(upgrade, deps({ authorize, connect }));

    expect(response?.status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404] as const)(
    "rejects a %i session or scope before DO attachment",
    async (status) => {
      const connect = vi.fn();
      const response = await handleLiveUpdateUpgrade(
        request("https://panel.test/acme/checkout/dev/live"),
        deps({ authorize: async () => ({ ok: false, status }), connect }),
      );

      expect(response?.status).toBe(status);
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it("requires HTTPS for hosted WebSocket upgrades", async () => {
    const authorize = vi.fn();
    const response = await handleLiveUpdateUpgrade(
      request("http://panel.test/acme/checkout/dev/live"),
      deps({ authorize, platformTarget: "production" }),
    );

    expect(response?.status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
  });
});

function deps(overrides: Partial<LiveUpdateUpgradeDeps> = {}): LiveUpdateUpgradeDeps {
  return {
    authorize: async () => ({ ok: true, scope, context }),
    connect: async () => new Response(null, { status: 200 }),
    ...overrides,
  };
}

function request(url: string, headers: Record<string, string> = {}): Request {
  const origin = new URL(url).origin;
  return new Request(url, { headers: { origin, upgrade: "websocket", ...headers } });
}
