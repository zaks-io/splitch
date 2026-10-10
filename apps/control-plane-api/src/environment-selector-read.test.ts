import { env } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestApp as createApp } from "./test-app-fixture";
import { allowLimiter } from "./test-constants";
import { resetOrganizationGraph, seedEnvironment, seedOrgApp } from "./test-seeds";

const APP_ID = "app_environment_selector_read";
const ENVIRONMENT_ID = "env_environment_selector_read";
const actor: Principal = {
  kind: "control-plane-token",
  id: "user_environment_selector_read",
  scopes: [`app:${APP_ID}:owner`],
  orgId: null,
  appId: APP_ID,
  environmentId: null,
  authDoor: "device_flow",
};

beforeEach(async () => {
  await resetOrganizationGraph(env.DB);
  await seedOrgApp(env.DB, {
    orgId: "org_environment_selector_read",
    orgName: "Selector Read",
    orgSlug: "selector-read",
    appId: APP_ID,
    appName: "Selector Read",
    appKey: "selector-read",
  });
  await seedEnvironment(env.DB, { appId: APP_ID, environmentId: ENVIRONMENT_ID, key: "prod" });
});

describe("Environment selector read reuse", () => {
  it("reads the full Environment once for canonical IDs and keys", async () => {
    const counting = countQueries(env.DB);
    const app = testApp(counting.d1);
    const byId = await app.request(`/apps/${APP_ID}/envs/${ENVIRONMENT_ID}`);
    const idQueries = counting.count();
    counting.reset();
    const byKey = await app.request(`/apps/${APP_ID}/envs/prod`);
    const keyQueries = counting.count();
    counting.reset();
    const explicitId = await app.request(`/apps/${APP_ID}/envs/${ENVIRONMENT_ID}?by=id`);
    const explicitQueries = counting.count();

    expect([byId.status, byKey.status, explicitId.status]).toEqual([200, 200, 200]);
    const expected = await explicitId.json();
    expect(await byId.json()).toEqual(expected);
    expect(await byKey.json()).toEqual(expected);
    expect([idQueries, keyQueries, explicitQueries]).toEqual([1, 1, 1]);
  });

  it("reuses the selector's proven miss", async () => {
    const counting = countQueries(env.DB);
    const response = await testApp(counting.d1).request(`/apps/${APP_ID}/envs/env_missing`);
    expect(response.status).toBe(404);
    expect(counting.count()).toBe(1);
  });

  it("keeps collision detection and its existing candidate payload", async () => {
    await seedEnvironment(env.DB, {
      appId: APP_ID,
      environmentId: "env_environment_selector_collision",
      key: ENVIRONMENT_ID,
    });
    const counting = countQueries(env.DB);
    const app = testApp(counting.d1);
    const ambiguous = await app.request(`/apps/${APP_ID}/envs/${ENVIRONMENT_ID}`);
    expect(ambiguous.status).toBe(409);
    expect(counting.count()).toBe(1);
    expect(await ambiguous.json()).toMatchObject({
      code: "SELECTOR_AMBIGUOUS",
      details: {
        candidates: [
          { environmentId: "env_environment_selector_collision", environmentKey: ENVIRONMENT_ID },
          { environmentId: ENVIRONMENT_ID, environmentKey: "prod" },
        ],
      },
    });
    const explicit = await app.request(`/apps/${APP_ID}/envs/${ENVIRONMENT_ID}?by=id`);
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject({ id: ENVIRONMENT_ID, key: "prod" });
  });
});

function testApp(d1: D1Database) {
  return createApp({
    authResolver: async () => ({ ok: true, principal: actor }),
    rateLimiter: allowLimiter,
    repo: createRepository(d1),
  });
}

function countQueries(d1: D1Database) {
  let prepared = 0;
  return {
    d1: new Proxy(d1, {
      get(target, property, receiver) {
        if (property === "prepare") prepared += 1;
        return Reflect.get(target, property, receiver);
      },
    }),
    count: () => prepared,
    reset: () => {
      prepared = 0;
    },
  };
}
