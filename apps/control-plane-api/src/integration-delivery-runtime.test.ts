import { env } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { beforeEach, expect, it, vi } from "vitest";
import { handleControlPlaneAppRequest } from "./control-plane-app-request";
import type { ControlPlaneApiEnv } from "./env";
import {
  resetOrganizationGraph,
  seedAppMember,
  seedEnvironment,
  seedOrgApp,
  seedOrgMember,
} from "./test-seeds";

const APP = "app_delivery_runtime";
const ENVIRONMENT = "env_requested";
const USER = "user_delivery";
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  await env.DB.batch(
    [
      "config_webhook_deliveries",
      "cloudflare_config_deliveries",
      "convex_installations",
      "cloudflare_installations",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  await resetOrganizationGraph(env.DB);
  await seedOrgApp(env.DB, {
    orgId: "org_delivery",
    orgName: "Delivery",
    appId: APP,
    appName: "Delivery",
    appKey: "delivery",
  });
  await seedOrgMember(env.DB, { orgId: "org_delivery", userId: USER, role: "admin" });
  await seedAppMember(env.DB, { appId: APP, userId: USER, role: "admin" });
  for (const environmentId of [ENVIRONMENT, "env_other"])
    await seedEnvironment(env.DB, { appId: APP, environmentId, key: environmentId });
  repo = createRepository(env.DB);
});

it.each(["cron", "coordinator"])(
  "deliver-now in %s mode never dispatches other Environments",
  async (mode) => {
    const wake = vi.fn(async () => {});
    const getByName = vi.fn(() => ({ wake }));
    const due = vi
      .spyOn(repo.integrationDeliverySchedule, "environmentsWithDueDeliveries")
      .mockResolvedValue([{ appId: APP, environmentId: "env_other" }]);
    const pending: Promise<unknown>[] = [];
    const response = await handleControlPlaneAppRequest({
      request: new Request(
        `https://api.test/apps/${APP}/envs/${ENVIRONMENT}/integrations/deliveries`,
        { method: "POST" },
      ),
      env: {
        ...env,
        SPLITCH_PLATFORM_TARGET: "local",
        INTEGRATION_DELIVERY_MODE: mode,
        INTEGRATION_DELIVERY: { getByName },
      } as ControlPlaneApiEnv,
      ctx: {
        waitUntil: (promise) => {
          pending.push(promise);
        },
      } as ExecutionContext,
      authResolver: () => ({
        ok: true,
        principal: {
          kind: "control-plane-token",
          id: USER,
          scopes: [`app:${APP}:admin`],
          orgId: null,
          appId: APP,
          environmentId: null,
          authDoor: "device_flow",
        },
      }),
      repo,
      door: "public",
      delegated: false,
    });
    await Promise.all(pending);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      wake: mode === "cron" ? "cron_noop" : "scheduled",
    });
    expect(due).not.toHaveBeenCalled();
    if (mode === "coordinator") {
      expect(getByName).toHaveBeenCalledExactlyOnceWith(`${APP}:${ENVIRONMENT}`);
      expect(wake).toHaveBeenCalledExactlyOnceWith(APP, ENVIRONMENT);
    } else expect(getByName).not.toHaveBeenCalled();
  },
);
