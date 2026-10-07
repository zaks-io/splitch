import { env } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { dispatchCloudflarePushes } from "./cloudflare-push-dispatch";
import { handleControlPlaneAppRequest } from "./control-plane-app-request";
import type { ControlPlaneApiEnv } from "./env";
import {
  resetOrganizationGraph,
  seedAppMember,
  seedEnvironment,
  seedOrgApp,
  seedOrgMember,
} from "./test-seeds";

const dispatch = vi.hoisted(() => {
  // Pool setup imports the Worker entrypoint before the dispatch mock is installed.
  vi.resetModules();
  return vi.fn(async (_input: unknown) => 0);
});
vi.mock("./cloudflare-push-dispatch", () => ({ dispatchCloudflarePushes: dispatch }));

const USER = "user_dispatch";
const APP_A = "app_dispatch_a";
const APP_B = "app_dispatch_b";
const ENVIRONMENT = "env_dispatch";
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  dispatch.mockClear();
  await resetOrganizationGraph(env.DB);
  await seedReachableApp(APP_A, "neuron");
  repo = createRepository(env.DB);
});

describe("immediate Cloudflare dispatch after resolved App mutations", () => {
  it("dispatches with the minted canonical App scope resolved from a slug", async () => {
    await seedReachableApp(APP_B, "other");
    const actor = principal(null, [APP_A, APP_B]);
    const { response, waitUntil } = await request(
      "/apps/neuron",
      "PATCH",
      { name: "Renamed" },
      actor,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: APP_A, name: "Renamed" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalled();
    await expectMintedDispatch(APP_A);
  });

  it.each(["GET", "HEAD"])("does not dispatch after a successful %s", async (method) => {
    const { response } = await request("/apps/neuron", method);
    expect(response.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch when a resolved App mutation fails in its handler", async () => {
    const now = "2026-10-05T00:00:00.000Z";
    await env.DB.prepare(`INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
      VALUES (?, ?, 'Taken', 'taken', ?, ?)`)
      .bind(APP_B, `org_${APP_A}`, now, now)
      .run();
    const { response } = await request("/apps/neuron", "PATCH", { key: "taken" });
    expect(response.status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch after invalid input", async () => {
    const { response } = await request("/apps/neuron", "PATCH", { name: "" });
    expect(response.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch an ambiguous selector mutation", async () => {
    await seedReachableApp(APP_B, "neuron");
    const actor = principal(APP_A, [APP_A, APP_B]);
    const { response } = await request("/apps/neuron", "PATCH", { name: "Renamed" }, actor);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SELECTOR_AMBIGUOUS" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch an unauthorized canonical App mutation", async () => {
    await seedReachableApp(APP_B, "other");
    const { response } = await request(`/apps/${APP_B}`, "PATCH", { name: "Renamed" });
    expect(response.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it("dispatches credential-bound Cloudflare registration without an App path parameter", async () => {
  await seedEnvironment(env.DB, { appId: APP_A, environmentId: ENVIRONMENT, key: "prod" });
  const actor: Principal = {
    kind: "api-key",
    id: "key_dispatch",
    scopes: ["data-plane:evaluate"],
    orgId: null,
    appId: APP_A,
    environmentId: ENVIRONMENT,
    authDoor: null,
  };
  const installationId = "33333333-3333-4333-8333-333333333333";
  const { response } = await request(
    "/api/integrations/cloudflare/installations",
    "POST",
    {
      installationId,
      endpoint:
        "https://splitch-config-dev.customer.workers.dev/integrations/splitch/configuration",
      pushSecret: "p".repeat(43),
    },
    actor,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    installationId,
    appId: APP_A,
    environmentId: ENVIRONMENT,
  });
  expect(dispatch).toHaveBeenCalledOnce();
  await expectMintedDispatch(APP_A);
});

async function request(
  path: string,
  method: string,
  body?: unknown,
  actor = principal(APP_A, [APP_A]),
) {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });
  const ctx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const runtime = {
    ...env,
    SPLITCH_PLATFORM_TARGET: "local",
    INTEGRATION_SECRET_KEK: KEK,
    INTEGRATION_SECRET_KEY_VERSION: "v1",
  } as ControlPlaneApiEnv;
  const response = await handleControlPlaneAppRequest({
    request: new Request(`https://control-plane.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env: runtime,
    ctx,
    repo,
    authResolver: async () => ({ ok: true, principal: actor }),
    door: "binding",
    delegated: true,
  });
  await Promise.all(pending);
  return { response, waitUntil };
}

async function expectMintedDispatch(appId: string) {
  const input = dispatch.mock.calls[0]?.[0] as Parameters<typeof dispatchCloudflarePushes>[0];
  expect(input.repo).toBe(repo);
  expect(input.scope).toEqual({ appId });
  if (!input.scope) throw new Error("Dispatch scope missing");
  // This repository read rejects fabricated plain objects, proving the scope was minted.
  await expect(repo.flags.flags.findMany(input.scope)).resolves.toEqual([]);
}

function principal(appId: string | null, appIds: string[]): Principal {
  return {
    kind: "control-plane-token",
    id: USER,
    scopes: appIds.map((id) => `app:${id}:owner`),
    orgId: null,
    appId,
    environmentId: null,
    authDoor: "device_flow",
  };
}

async function seedReachableApp(appId: string, appKey: string) {
  const orgId = `org_${appId}`;
  await seedOrgApp(env.DB, {
    orgId,
    orgName: appId,
    orgSlug: appId,
    appId,
    appName: appKey,
    appKey,
  });
  await seedOrgMember(env.DB, { orgId, userId: USER, role: "owner" });
  await seedAppMember(env.DB, { appId, userId: USER, role: "owner" });
}
