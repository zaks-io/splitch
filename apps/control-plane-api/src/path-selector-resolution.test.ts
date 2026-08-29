import { env } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { ConfigStoreAccess } from "./config-store-do";
import {
  resetOrganizationGraph,
  seedAppMember,
  seedEnvironment,
  seedOrgApp,
  seedOrgMember,
} from "./test-seeds";

const USER = "user_selector";
const APP_A = "app_selector_a";
const APP_B = "app_selector_b";
beforeEach(() => resetOrganizationGraph(env.DB));

describe("authenticated control-plane path selectors", () => {
  it("returns the same Flag list by App ID or unique App key with one extra query", async () => {
    await seedReachableApp(env.DB, {
      orgId: "org_selector_a",
      orgSlug: "alpha",
      appId: APP_A,
      appKey: "neuron",
    });
    const counting = countQueries(env.DB);
    const app = testApp(createRepository(counting.d1), principal(APP_A, [APP_A]));

    counting.reset();
    const byId = await app.request(`/apps/${APP_A}/flags`);
    const idQueries = counting.count();
    counting.reset();
    const byName = await app.request("/apps/neuron/flags");
    const nameQueries = counting.count();

    expect(byId.status).toBe(200);
    expect(byName.status).toBe(200);
    expect(await byName.json()).toEqual(await byId.json());
    expect(nameQueries - idQueries).toBe(1);
  });

  it("returns only fully membership-bounded ambiguity candidates", async () => {
    await seedReachableApp(env.DB, {
      orgId: "org_selector_a",
      orgSlug: "alpha",
      appId: APP_A,
      appKey: "neuron",
    });
    await seedReachableApp(env.DB, {
      orgId: "org_selector_b",
      orgSlug: "beta",
      appId: APP_B,
      appKey: "neuron",
    });
    await seedReachableApp(env.DB, {
      orgId: "org_selector_scope_excluded",
      orgSlug: "scope-excluded",
      appId: "app_selector_scope_excluded",
      appKey: "neuron",
    });
    await seedHalfReachableApp(env.DB, {
      orgId: "org_selector_c",
      orgSlug: "charlie",
      appId: "app_selector_c",
      appKey: "neuron",
      membership: "app",
    });
    await seedHalfReachableApp(env.DB, {
      orgId: "org_selector_d",
      orgSlug: "delta",
      appId: "app_selector_d",
      appKey: "neuron",
      membership: "org",
    });

    const app = testApp(createRepository(env.DB), principal(APP_A, [APP_A, APP_B]));
    const response = await app.request("/apps/neuron/flags");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "SELECTOR_AMBIGUOUS",
      message: 'App selector "neuron" matches more than one App',
      details: {
        recommendedAction: "USE_CANONICAL_ID",
        candidates: [
          { orgSlug: "alpha", appId: APP_A, appSlug: "neuron" },
          { orgSlug: "beta", appId: APP_B, appSlug: "neuron" },
        ],
      },
    });
  });
});

describe("selector resolution failures and descendant selectors", () => {
  it("matches unknown-name and unknown-ID errors when either membership predicate fails", async () => {
    await seedHalfReachableApp(env.DB, {
      orgId: "org_selector_c",
      orgSlug: "charlie",
      appId: "app_selector_c",
      appKey: "secret",
      membership: "app",
    });
    await seedHalfReachableApp(env.DB, {
      orgId: "org_selector_d",
      orgSlug: "delta",
      appId: "app_selector_d",
      appKey: "secret",
      membership: "org",
    });
    const app = testApp(createRepository(env.DB), principal("app_missing", ["app_missing"]));

    const byName = await app.request("/apps/secret/flags");
    const byId = await app.request("/apps/app_missing/flags");

    expect(byName.status).toBe(404);
    expect(byId.status).toBe(404);
    expect(await byName.json()).toEqual(await byId.json());
  });

  it("matches unknown-name and unknown-ID errors for Environment and Flag selectors", async () => {
    await seedReachableApp(env.DB, {
      orgId: "org_selector_a",
      orgSlug: "alpha",
      appId: APP_A,
      appKey: "neuron",
    });
    const app = testApp(createRepository(env.DB), principal(APP_A, [APP_A]));

    const environmentByName = await app.request(`/apps/${APP_A}/envs/missing-environment`);
    const environmentById = await app.request(`/apps/${APP_A}/envs/env_missing`);
    const flagByName = await app.request(`/apps/${APP_A}/flags/missing-flag`);
    const flagById = await app.request(`/apps/${APP_A}/flags/flag_missing`);

    expect(environmentByName.status).toBe(404);
    expect(environmentById.status).toBe(404);
    expect(await environmentByName.json()).toEqual(await environmentById.json());
    expect(flagByName.status).toBe(404);
    expect(flagById.status).toBe(404);
    expect(await flagByName.json()).toEqual(await flagById.json());
  });

  it("holds canonical selectors to one query and key selectors to three", async () => {
    await seedReachableApp(env.DB, {
      orgId: "org_selector_a",
      orgSlug: "alpha",
      appId: APP_A,
      appKey: "neuron",
    });
    await seedEnvironment(env.DB, {
      appId: APP_A,
      environmentId: "env_selector_prod",
      key: "prod",
    });
    await seedFlag(env.DB, APP_A, "flag_selector_checkout", "checkout");

    const counting = countQueries(env.DB);
    const seen: Array<{ appId: string; environmentId: string; flagId: string }> = [];
    const app = testApp(
      createRepository(counting.d1),
      principal(APP_A, [APP_A]),
      configStore(seen),
    );

    counting.reset();
    const byId = await app.request(
      `/apps/${APP_A}/envs/env_selector_prod/flags/flag_selector_checkout/config`,
    );
    const idQueries = counting.count();
    counting.reset();
    const byName = await app.request("/apps/neuron/envs/prod/flags/checkout/config");
    const nameQueries = counting.count();
    expect(byId.status).toBe(200);
    expect(byName.status).toBe(200);
    expect(await byName.json()).toEqual(await byId.json());
    expect([idQueries, nameQueries]).toEqual([1, 3]);
    expect(seen.at(-1)).toEqual({
      appId: APP_A,
      environmentId: "env_selector_prod",
      flagId: "flag_selector_checkout",
    });
  });
});

describe("custom live-update path selectors", () => {
  it("resolves App and Environment names", async () => {
    await seedReachableApp(env.DB, {
      orgId: "org_selector_a",
      orgSlug: "alpha",
      appId: APP_A,
      appKey: "neuron",
    });
    await seedEnvironment(env.DB, {
      appId: APP_A,
      environmentId: "env_selector_prod",
      key: "prod",
    });
    const liveSeen: Array<{ appId: string; environmentId: string }> = [];
    const app = testApp(
      createRepository(env.DB),
      principal(APP_A, [APP_A]),
      configStore([], liveSeen),
    );

    const response = await app.request("/apps/neuron/envs/prod/live");

    expect(response.status).toBe(200);
    expect(liveSeen).toEqual([{ appId: APP_A, environmentId: "env_selector_prod" }]);
  });
});

function testApp(
  repo: ReturnType<typeof createRepository>,
  actor: Principal,
  store?: ConfigStoreAccess,
) {
  return createApp({
    authResolver: async () => ({ ok: true, principal: actor }),
    rateLimiter: () => ({ limited: false }),
    repo,
    configStore: store,
  });
}

function principal(appId: string, appIds: readonly string[]): Principal {
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

async function seedReachableApp(
  d1: D1Database,
  row: { orgId: string; orgSlug: string; appId: string; appKey: string },
) {
  await seedHalfReachableApp(d1, { ...row, membership: "both" });
}

async function seedHalfReachableApp(
  d1: D1Database,
  row: {
    orgId: string;
    orgSlug: string;
    appId: string;
    appKey: string;
    membership: "org" | "app" | "both";
  },
) {
  await seedOrgApp(d1, {
    orgId: row.orgId,
    orgName: row.orgSlug,
    orgSlug: row.orgSlug,
    appId: row.appId,
    appName: row.appKey,
    appKey: row.appKey,
  });
  if (row.membership !== "app") {
    await seedOrgMember(d1, { orgId: row.orgId, userId: USER, role: "owner" });
  }
  if (row.membership !== "org") {
    await seedAppMember(d1, { appId: row.appId, userId: USER, role: "owner" });
  }
}

async function seedFlag(d1: D1Database, appId: string, flagId: string, key: string) {
  await d1
    .prepare(
      "INSERT INTO flags (id, app_id, key, name, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(flagId, appId, key, key, "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z", 1)
    .run();
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

function configStore(
  seen: Array<{ appId: string; environmentId: string; flagId: string }>,
  liveSeen: Array<{ appId: string; environmentId: string }> = [],
) {
  return {
    writerFor() {
      return {
        async readFlagConfig(input: { appId: string; environmentId: string; flagId: string }) {
          seen.push(input);
          return {
            ok: true as const,
            config: {
              flagId: input.flagId,
              environmentId: input.environmentId,
              version: 1,
              enabled: false,
              availableVariantNames: [],
              targetingRules: [],
              rollout: null,
              experiment: null,
            },
          };
        },
      } as never;
    },
    liveUpdatesFor(appId: string, environmentId: string) {
      liveSeen.push({ appId, environmentId });
      return { connect: async () => Response.json({ connected: true }) };
    },
  } satisfies ConfigStoreAccess;
}
