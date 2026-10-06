import { createHmac } from "node:crypto";
import type { ConvexInstallationRow, Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { makeConvexHandlers } from "./convex-handlers";
import { encryptConvexSecret } from "./convex-secret";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-10-06T00:00:00.000Z");
const SECRET = "s".repeat(43);
const INPUT = {
  installationId: "00000000-0000-4000-8000-000000000001",
  callbackUrl: "https://gateway.chat.zaks.io/integrations/splitch/configuration",
  webhookSecret: SECRET,
  callbackVerification: "hmac-sha256" as const,
};

describe("verified callback installation", () => {
  it("verifies a custom receiver before saving and keeps the scoped response", async () => {
    const fixture = setup();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(fixture.createInstallation).not.toHaveBeenCalled();
      const { installationId, challenge } = JSON.parse(init?.body as string);
      return new Response(null, {
        status: 204,
        headers: {
          "splitch-callback-proof": createHmac("sha256", SECRET)
            .update(`callback.verify:${installationId}:${challenge}`)
            .digest("hex"),
        },
      });
    });
    const response = await fixture.handlers(fetcher).create(args(INPUT));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      installationId: INPUT.installationId,
      appId: "app_1",
      environmentId: "env_1",
      environmentVersion: 7,
      status: "active",
    });
    expect(fixture.createInstallation).toHaveBeenCalledOnce();
  });

  it.each([
    [204, 400],
    [401, 400],
    [302, 400],
    [503, 503],
  ])("does not save when the receiver returns %s without proof", async (status, expected) => {
    const fixture = setup();
    const response = await fixture
      .handlers(async () => new Response(null, { status }))
      .create(args(INPUT));
    expect(response.status).toBe(expected);
    expect(fixture.createInstallation).not.toHaveBeenCalled();
  });

  it("rejects unsafe destinations before reading state or sending", async () => {
    const fixture = setup();
    const fetcher = vi.fn();
    const response = await fixture.handlers(fetcher).create(
      args({
        ...INPUT,
        callbackUrl: "https://127.0.0.1/configuration",
      }),
    );
    expect(response.status).toBe(400);
    expect(fixture.getInstallation).not.toHaveBeenCalled();
    expect(fixture.createInstallation).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an unscoped principal before sending", async () => {
    const fixture = setup();
    const fetcher = vi.fn();
    const input = args(INPUT);
    delete input.principal.environmentId;
    const response = await fixture.handlers(fetcher).create(input);
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fixture.createInstallation).not.toHaveBeenCalled();
  });
});

describe("installation retries and old components", () => {
  it.each(["active", "revoked"] as const)(
    "replays a stored %s installation without a challenge",
    async (status) => {
      const existing = await stored(status);
      const fixture = setup(existing);
      const fetcher = vi.fn();
      const response = await fixture.handlers(fetcher).create(args(INPUT));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status });
      expect(fetcher).not.toHaveBeenCalled();
      expect(fixture.createInstallation).not.toHaveBeenCalled();
    },
  );

  it("rejects changed registration content before a challenge", async () => {
    const fixture = setup(await stored("active"));
    const fetcher = vi.fn();
    const response = await fixture
      .handlers(fetcher)
      .create(args({ ...INPUT, webhookSecret: "changed".repeat(8) }));
    expect(response.status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fixture.createInstallation).not.toHaveBeenCalled();
  });

  it("checks the winning insert after concurrent different registration content", async () => {
    const winner = await stored("active");
    const fixture = setup();
    fixture.createInstallation.mockResolvedValueOnce(winner);
    const response = await fixture
      .handlers(async (_url, init) => {
        const { installationId, challenge } = JSON.parse(init?.body as string);
        return new Response(null, {
          status: 204,
          headers: {
            "splitch-callback-proof": createHmac("sha256", SECRET)
              .update(`callback.verify:${installationId}:${challenge}`)
              .digest("hex"),
          },
        });
      })
      .create(args({ ...INPUT, callbackUrl: "https://other.example.com/configuration" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it.each([
    ["https://example.convex.site/configuration", 200],
    [INPUT.callbackUrl, 400],
  ])("preserves the old-component policy for %s", async (callbackUrl, status) => {
    const fixture = setup();
    const fetcher = vi.fn();
    const { callbackVerification: _capability, ...legacy } = INPUT;
    expect((await fixture.handlers(fetcher).create(args({ ...legacy, callbackUrl }))).status).toBe(
      status,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

type Registration = Omit<typeof INPUT, "callbackVerification"> & {
  callbackVerification?: "hmac-sha256";
};

function args(body: Registration): HandlerArgs<{ body: Registration }> {
  return {
    input: { body },
    principal: {
      kind: "api-key",
      id: "key_1",
      appId: "app_1",
      environmentId: "env_1",
      scopes: ["data-plane:evaluate"],
    },
    requestId: "request_1",
    request: new Request("https://api.splitch.dev/api/integrations/convex/installations"),
  } as HandlerArgs<{ body: Registration }>;
}

async function stored(status: "active" | "revoked") {
  const secret = await encryptConvexSecret(SECRET, KEY, "v1");
  return {
    ...INPUT,
    appId: "app_1",
    environmentId: "env_1",
    status,
    secretFingerprint: secret.fingerprint,
  } as unknown as ConvexInstallationRow;
}

function setup(initial: ConvexInstallationRow | null = null) {
  const getInstallation = vi.fn(async () => initial);
  const createInstallation = vi.fn(
    async (_scope: unknown, input: Record<string, unknown>) =>
      ({
        ...input,
        appId: "app_1",
        environmentId: "env_1",
        status: "active",
      }) as unknown as ConvexInstallationRow,
  );
  const repo = {
    convex: { getInstallation, createInstallation, environmentVersion: async () => 7 },
  } as unknown as Repository;
  return {
    getInstallation,
    createInstallation,
    handlers: (fetcher: typeof fetch) =>
      makeConvexHandlers({ repo, webhookKek: KEY, now: () => NOW, fetcher }),
  };
}
