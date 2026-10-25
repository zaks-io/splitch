import { ConvexInstallationStatusSchema } from "@splitch/contracts";
import { createRepository, envScope } from "@splitch/db";
import { createLocalD1, type LocalD1 } from "@splitch/db/test-d1-pool";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { reprobeDormantConvexDeployments } from "./convex-deployments";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";
import { signIntegrationPayload } from "./integration-secret";
import { allowLimiter } from "./test-constants";
import { seedEnvironment, seedOrgApp } from "./test-seeds";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-10-25T08:00:00.000Z");
const BODY = {
  installationId: "00000000-0000-4000-8000-000000000001",
  callbackUrl: "https://example.convex.site/configuration",
  webhookSecret: "s".repeat(43),
  callbackVerification: "hmac-sha256" as const,
};
const PATH = "/api/integrations/convex/installations";
let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let app: ReturnType<typeof createApp>;
let verificationFails: boolean;

beforeEach(async () => {
  verificationFails = false;
  local = await createLocalD1();
  await seedOrgApp(local.d1, {
    orgId: "org",
    orgName: "Org",
    appId: "app",
    appName: "App",
    appKey: "app",
  });
  await seedEnvironment(local.d1, { appId: "app", environmentId: "env", key: "dev" });
  repo = createRepository(local.d1);
  app = createApp({
    door: "binding",
    repo,
    rateLimiter: allowLimiter,
    authResolver: async () => ({
      ok: true,
      principal: {
        kind: "api-key",
        id: "key",
        orgId: null,
        appId: "app",
        environmentId: "env",
        scopes: ["data-plane:evaluate", "data-plane:write"],
        authDoor: null,
      },
    }),
    convex: {
      webhookKek: KEY,
      webhookKeyVersion: "v1",
      now: () => NOW,
      fetcher: async (_url, init) => {
        if (verificationFails) return new Response(null, { status: 404 });
        const { installationId, challenge } = JSON.parse(init?.body as string);
        const hex = await signIntegrationPayload(
          BODY.webhookSecret,
          `callback.verify:${installationId}:${challenge}`,
        );
        return new Response(null, { status: 204, headers: { "splitch-callback-proof": hex } });
      },
    },
  });
});
afterEach(async () => local.dispose());

async function register(expectedStatus = 200) {
  const response = await app.request(PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(BODY),
  });
  expect(response.status).toBe(expectedStatus);
  return response;
}
async function health() {
  const response = await app.request(`${PATH}/${BODY.installationId}`);
  expect(response.status).toBe(200);
  return ConvexInstallationStatusSchema.parse(await response.json());
}
async function changeConfig() {
  await local.d1
    .prepare("UPDATE environments SET config_version = config_version + 1 WHERE id = 'env'")
    .run();
}
async function dispatch(fetcher: typeof fetch) {
  return dispatchConvexWebhooks({
    repo,
    webhookKek: KEY,
    webhookKeyVersion: "v1",
    now: () => new Date("2099-01-01T00:00:00.000Z"),
    fetcher,
  });
}

describe("Convex deployment HTTP lifecycle on real D1", () => {
  it("ignores a v1 deletion probe that completes after a successful v2 delivery", async () => {
    await register();
    await changeConfig();
    const probe = pendingResponse();
    const first = dispatch(async (url) =>
      String(url).endsWith("/version") ? probe.fetch() : deleted(),
    );
    await probe.ready;
    await changeConfig();
    expect(await dispatch(async () => new Response(null, { status: 204 }))).toBe(1);
    expect(await health()).toMatchObject({ lastDeliveredVersion: 2 });
    probe.release(deleted());
    await first;
    expect(await health()).toMatchObject({ deploymentMissingAt: null });
    await changeConfig();
    expect(await health()).toMatchObject({ environmentVersion: 3, pendingCount: 1 });
    expect(await dispatch(async () => new Response(null, { status: 204 }))).toBe(1);
    expect(await health()).toMatchObject({ lastDeliveredVersion: 3 });
  });

  it("invalidates a pending deletion probe when an active installation re-registers", async () => {
    await register();
    await changeConfig();
    const probe = pendingResponse();
    const first = dispatch(async (url) =>
      String(url).endsWith("/version") ? probe.fetch() : deleted(),
    );
    await probe.ready;
    await register();
    probe.release(deleted());
    await first;
    expect(await health()).toMatchObject({ deploymentMissingAt: null });
    await changeConfig();
    expect(await health()).toMatchObject({ pendingCount: 1 });
  });

  it.each(["registration", "reprobe"])(
    "recovers through %s and delivers the current and next versions",
    async (recovery) => {
      await register();
      await changeConfig();
      await dispatch(
        async () => new Response(null, { status: 404, headers: { "convex-usher": "usher" } }),
      );
      expect(await health()).toMatchObject({
        status: "active",
        deploymentMissingAt: "2099-01-01T00:00:00.000Z",
        pendingCount: 0,
      });
      await changeConfig();
      expect(await health()).toMatchObject({ pendingCount: 0 });
      if (recovery === "registration") await register();
      else
        await reprobeDormantConvexDeployments({
          repo,
          now: NOW,
          fetcher: async () => new Response("1.0", { status: 200 }),
        });
      expect(await health()).toMatchObject({
        status: "active",
        deploymentMissingAt: null,
        pendingCount: 1,
      });
      const version = await repo.convex.environmentVersion(envScope("app", "env"));
      expect(await dispatch(async () => new Response(null, { status: 204 }))).toBe(1);
      expect(await health()).toMatchObject({ pendingCount: 0, lastDeliveredVersion: version });
      await changeConfig();
      expect(await dispatch(async () => new Response(null, { status: 204 }))).toBe(1);
      expect(await health()).toMatchObject({ lastDeliveredVersion: version + 1 });
    },
  );
});

function pendingResponse() {
  let release!: (response: Response) => void;
  let started!: () => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    ready,
    release: (response: Response) => release(response),
    fetch: async () => {
      started();
      return pending;
    },
  };
}
const deleted = () => new Response(null, { status: 404, headers: { "convex-usher": "usher" } });

describe("Convex recovery interleavings on real D1", () => {
  it.each([true, false])(
    "uses current dormancy after a stale active read, receiver verified=%s",
    async (verified) => {
      await register();
      await changeConfig();
      const probe = pendingResponse();
      const sending = dispatch(async (url) =>
        String(url).endsWith("/version") ? probe.fetch() : deleted(),
      );
      await probe.ready;
      const read = repo.convex.getInstallation.bind(repo.convex);
      vi.spyOn(repo.convex, "getInstallation").mockImplementationOnce(async (...args) => {
        const stale = await read(...args);
        probe.release(deleted());
        await sending;
        return stale;
      });
      verificationFails = !verified;
      const response = await register(verified ? 200 : 400);
      if (verified) expect(await response.json()).toMatchObject({ deploymentMissingAt: null });
      expect(await health()).toMatchObject({
        deploymentMissingAt: verified ? null : "2099-01-01T00:00:00.000Z",
        pendingCount: verified ? 1 : 0,
      });
      await changeConfig();
      expect(await health()).toMatchObject({ pendingCount: verified ? 2 : 0 });
    },
  );

  it("returns actual dormancy when a newer lifecycle event supersedes verified registration", async () => {
    await register();
    await changeConfig();
    await dispatch(async () => deleted());
    const recover = repo.convex.reactivateDeployment.bind(repo.convex);
    vi.spyOn(repo.convex, "reactivateDeployment").mockImplementationOnce(
      async (scope, id, token, now) => {
        const newer = await repo.convex.recordDeploymentCheck(scope, id, now);
        if (!newer) throw new Error("Expected a current lifecycle generation");
        await repo.convex.markDeploymentMissing(id, newer.probeToken, now);
        await changeConfig();
        await recover(scope, id, token, now);
      },
    );
    const response = await register();
    expect(await response.json()).toMatchObject({
      deploymentMissingAt: "2099-01-01T00:00:00.000Z",
    });
    expect(await health()).toMatchObject({
      deploymentMissingAt: "2099-01-01T00:00:00.000Z",
      pendingCount: 0,
    });
  });

  it("ignores an old daily live result after registration and a newer confirmed deletion", async () => {
    await register();
    await changeConfig();
    await dispatch(async () => deleted());
    const probe = pendingResponse();
    const checking = reprobeDormantConvexDeployments({ repo, now: NOW, fetcher: probe.fetch });
    await probe.ready;
    await register();
    await dispatch(async () => deleted());
    await changeConfig();
    probe.release(new Response("1.0", { status: 200 }));
    await checking;
    expect(await health()).toMatchObject({
      deploymentMissingAt: "2099-01-01T00:00:00.000Z",
      pendingCount: 0,
    });
    const deliveries = await local.d1
      .prepare(
        "SELECT environment_version FROM config_webhook_deliveries WHERE installation_id = ? AND environment_version = 2",
      )
      .bind(BODY.installationId)
      .all();
    expect(deliveries.results).toEqual([]);
    await changeConfig();
    expect(await health()).toMatchObject({ pendingCount: 0 });
  });
});
