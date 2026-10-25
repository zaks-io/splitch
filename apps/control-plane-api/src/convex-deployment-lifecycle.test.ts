import { ConvexInstallationStatusSchema } from "@splitch/contracts";
import { createRepository, envScope } from "@splitch/db";
import { createLocalD1, type LocalD1 } from "@splitch/db/test-d1-pool";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(async () => {
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

async function register() {
  const response = await app.request(PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(BODY),
  });
  expect(response.status).toBe(200);
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
    let releaseProbe!: (response: Response) => void;
    let started!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pendingProbe = new Promise<Response>((resolve) => {
      releaseProbe = resolve;
    });
    const first = dispatch(async (url) => {
      if (String(url).endsWith("/version")) {
        started();
        return pendingProbe;
      }
      return new Response(null, { status: 404 });
    });
    await probeStarted;
    await changeConfig();
    expect(await dispatch(async () => new Response(null, { status: 204 }))).toBe(1);
    expect(await health()).toMatchObject({ lastDeliveredVersion: 2 });
    releaseProbe(new Response(null, { status: 404, headers: { "convex-usher": "usher" } }));
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
    let releaseProbe!: (response: Response) => void;
    let started!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pendingProbe = new Promise<Response>((resolve) => {
      releaseProbe = resolve;
    });
    const first = dispatch(async (url) => {
      if (String(url).endsWith("/version")) {
        started();
        return pendingProbe;
      }
      return new Response(null, { status: 404 });
    });
    await probeStarted;
    await register();
    releaseProbe(new Response(null, { status: 404, headers: { "convex-usher": "usher" } }));
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
