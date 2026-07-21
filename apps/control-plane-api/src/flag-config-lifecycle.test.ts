import { flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfigStore } from "./config-store";
import { initializeFlagConfigsForFlag } from "./flag-config-lifecycle";
import {
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "./flag-definition-test-harness";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness();
  h.app = makeAppForRepo(h, createRepository(h.bindings.d1), configStoreAccess(h));
});

afterEach(async () => h.bindings.dispose());

describe("flag configuration lifecycle on Flag create", () => {
  it("creates one disabled Flag Configuration per Environment", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);

    for (const environment of createdApp.environments) {
      const scope = envScope(createdApp.app.id, environment.id);
      const config = await repo.flags.getFlagConfig(scope, flag.id);
      expect(config).toMatchObject({
        flagId: flag.id,
        environmentId: environment.id,
        enabled: false,
        defaultVariantId: flag.defaultVariantId,
        availableVariantNames: "[]",
      });
      expect(await repo.flags.listTargetingRules(scope, flag.id)).toEqual([]);
    }
  });

  it("is idempotent when lifecycle initialization is retried", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);

    await initializeFlagConfigsForFlag(
      { repo, nowIso: () => NOW_ISO },
      { appId: createdApp.app.id, flagId: flag.id, defaultVariantId: flag.defaultVariantId },
    );

    for (const environment of createdApp.environments) {
      const configs = await repo.flags.flagConfigs.findMany(
        envScope(createdApp.app.id, environment.id),
      );
      expect(configs.filter((row) => row.flagId === flag.id)).toHaveLength(1);
    }
  });

  it("rolls back the Flag when config initialization fails", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const repo = createRepository(h.bindings.d1);
    const environments = await repo.identity.listEnvironments(appScope(createdApp.app.id));
    h.app = makeAppForRepo(h, faultingRepo(repo, 2), configStoreAccess(h));

    const res = await h.app.request(`/apps/${createdApp.app.id}/flags`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify(baseFlag(createdApp.app.id)),
    });

    expect(res.status).toBe(500);
    expect(
      (await repo.flags.flags.findMany(appScope(createdApp.app.id))).some(
        (row) => row.key === "checkout-redesign",
      ),
    ).toBe(false);
    for (const environment of environments) {
      expect(
        await repo.flags.flagConfigs.findMany(envScope(createdApp.app.id, environment.id)),
      ).toHaveLength(0);
    }
  });
});

describe("flag configuration lifecycle on Environment create", () => {
  it("creates one disabled Flag Configuration per existing Flag", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);

    const res = await request(h, "POST", `/apps/${createdApp.app.id}/envs`, jwt, {
      key: "staging",
      name: "Staging",
    });
    expect(res.status).toBe(200);
    const staging = (await res.json()) as { id: string };

    const config = await createRepository(h.bindings.d1).flags.getFlagConfig(
      envScope(createdApp.app.id, staging.id),
      flag.id,
    );
    expect(config).toMatchObject({
      flagId: flag.id,
      environmentId: staging.id,
      enabled: false,
      defaultVariantId: flag.defaultVariantId,
      availableVariantNames: "[]",
    });
  });

  it("rolls back the Environment when config initialization fails", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);
    h.app = makeAppForRepo(h, faultingRepo(repo, 1), configStoreAccess(h));

    const res = await h.app.request(`/apps/${createdApp.app.id}/envs`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ key: "staging", name: "Staging" }),
    });

    expect(res.status).toBe(500);
    expect(
      (await repo.identity.listEnvironments(appScope(createdApp.app.id))).some(
        (env) => env.key === "staging",
      ),
    ).toBe(false);
  });
});

describe("flag configuration onboarding path", () => {
  it("supports create → configure dev → read config through the normal API", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();

    const disabled = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/envs/${dev?.id}/flags/${flag.id}/config`,
      jwt,
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      flagId: flag.id,
      environmentId: dev?.id,
      enabled: false,
      availableVariantNames: [],
      targetingRules: [],
    });

    const configured = await request(
      h,
      "PATCH",
      `/apps/${createdApp.app.id}/envs/${dev?.id}/flags/${flag.id}/config`,
      jwt,
      { enabled: true, availableVariantNames: ["control"] },
    );
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({
      enabled: true,
      availableVariantNames: ["control"],
      version: 2,
    });

    const store = makeConfigStore({
      repo: createRepository(h.bindings.d1),
      kv: h.bindings.kv,
      broadcaster: { broadcast: vi.fn() },
      now: () => new Date(Date.parse(NOW_ISO)),
    });
    const snapshot = await store.readFlagConfig({
      appId: createdApp.app.id,
      environmentId: dev?.id ?? "",
      flagId: flag.id,
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.config).toMatchObject({
      enabled: true,
      availableVariantNames: ["control"],
    });

    const kvKey = flagConfigKey(createdApp.app.id, dev?.id ?? "", flag.key);
    expect(await h.bindings.kv.get(kvKey, "text")).toEqual(expect.any(String));
  });

  it("cascade-deletes Environment configs when a Flag is deleted", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);

    const del = await request(h, "DELETE", `/apps/${createdApp.app.id}/flags/${flag.id}`, jwt);
    expect(del.status).toBe(200);

    for (const environment of createdApp.environments) {
      expect(
        await repo.flags.getFlagConfig(envScope(createdApp.app.id, environment.id), flag.id),
      ).toBeNull();
    }
  });
});

function configStoreAccess(harness: FlagDefinitionHarness) {
  const repo = createRepository(harness.bindings.d1);
  const store = makeConfigStore({
    repo,
    kv: harness.bindings.kv,
    broadcaster: { broadcast: vi.fn() },
    now: () => new Date(Date.parse(NOW_ISO)),
  });
  return {
    writerFor: (_appId: string, _environmentId: string) => store,
    liveUpdatesFor: () => ({
      connect: async () => new Response("test live updates unavailable", { status: 503 }),
    }),
  };
}

function faultingRepo(repo: ReturnType<typeof createRepository>, failOnAttempt: number) {
  let attempt = 0;
  const originalEnsure = repo.flags.ensureInitialFlagConfig.bind(repo.flags);
  repo.flags.ensureInitialFlagConfig = async (...args) => {
    attempt += 1;
    if (attempt === failOnAttempt) throw new Error("injected config init failure");
    return originalEnsure(...args);
  };
  return repo;
}
