import { flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp as createEvaluationApp } from "../../evaluation-api/src/app";
import { StaticSaltStore } from "../../evaluation-api/src/assignment/assignment-store-test-fixtures";
import { makeDataPlaneAuthResolver } from "../../evaluation-api/src/data-plane-auth";
import { RecordingAssignmentStore } from "../../evaluation-api/src/evaluate/evaluate-path-test-fixtures";
import {
  RecordingEvaluationCommitSink,
  RecordingEvaluationUsageSink,
  RecordingExposureSink,
} from "../../evaluation-api/src/sdk-route-test-fixtures";
import { KvProvider } from "../../evaluation-api/src/provider/kv-provider";
import { makeConfigStore } from "./config-store";
import { initializeFlagConfigsForFlag } from "./flag-config-lifecycle";
import {
  baseFlag,
  createFlag,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "./flag-definition-test-harness";
import { type MigratedLocalBindings, makeMigratedLocalBindings } from "./migration-test-fixtures";
import { seedOrgApp, seedOrgMember } from "./test-seeds";

export const LIFECYCLE_ORG = {
  orgId: "org_flag_config_lifecycle",
  orgName: "Flag Config Lifecycle Co",
  appId: "app_existing_flag_config_lifecycle",
  appName: "Existing Flag Config Lifecycle App",
  appKey: "existing-flag-config-lifecycle",
};
const LIFECYCLE_OWNER = "user_flag_config_lifecycle_owner";

interface LifecycleHarness extends FlagDefinitionHarness {
  bindings: MigratedLocalBindings;
}

let h: LifecycleHarness;

beforeEach(async () => {
  const bindings = await makeMigratedLocalBindings();
  await seedOrgApp(bindings.d1, LIFECYCLE_ORG);
  await seedOrgMember(bindings.d1, {
    orgId: LIFECYCLE_ORG.orgId,
    userId: LIFECYCLE_OWNER,
    role: "owner",
  });
  const base = await makeFlagDefinitionHarness();
  await base.bindings.dispose();
  h = {
    bindings,
    signer: base.signer,
    app: makeAppForRepo(
      { bindings, signer: base.signer },
      createRepository(bindings.d1),
      configStoreAccess(bindings),
      bindings.credentialKv,
    ),
  };
});

afterEach(async () => h.bindings.dispose());

describe("flag configuration lifecycle on Flag create", () => {
  it("creates one disabled Flag Configuration per Environment", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
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
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);

    await initializeFlagConfigsForFlag(
      { repo, configStore: configStoreAccess(h.bindings), nowIso: () => NOW_ISO },
      { appId: createdApp.app.id, flagId: flag.id, defaultVariantId: flag.defaultVariantId },
    );

    for (const environment of createdApp.environments) {
      const configs = await repo.flags.flagConfigs.findMany(
        envScope(createdApp.app.id, environment.id),
      );
      expect(configs.filter((row) => row.flagId === flag.id)).toHaveLength(1);
    }
  });

  it("rolls back the Flag and purges KV when config initialization fails", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const repo = createRepository(h.bindings.d1);
    const environments = await repo.identity.listEnvironments(appScope(createdApp.app.id));
    h.app = makeAppForRepo(
      h,
      faultingRepo(repo, 2),
      configStoreAccess(h.bindings),
      h.bindings.credentialKv,
    );

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
      expect(
        await h.bindings.configKv.get(
          flagConfigKey(createdApp.app.id, environment.id, "checkout-redesign"),
          "text",
        ),
      ).toBeNull();
    }
  });
});

describe("flag configuration lifecycle on Environment create", () => {
  it("creates one disabled Flag Configuration per existing Flag", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
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

  it("rolls back the Environment when the second config insert fails under real FK constraints", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    await createFlag(h, createdApp.app.id, jwt);
    await createFlag(h, createdApp.app.id, jwt, {
      ...baseFlag(createdApp.app.id),
      key: "second-flag",
      name: "Second flag",
    });
    const repo = createRepository(h.bindings.d1);
    h.app = makeAppForRepo(
      h,
      faultingRepo(repo, 2),
      configStoreAccess(h.bindings),
      h.bindings.credentialKv,
    );

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
    expect(await countFlagConfigs(repo, createdApp.app.id)).toBe(4);
  });

  it("rolls back configs and the Environment when Client Key cache provisioning fails", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);
    h.app = makeAppForRepo(
      h,
      repo,
      configStoreAccess(h.bindings),
      faultingCredentialProvisionKv(h.bindings.credentialKv),
    );

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
    expect(await countFlagConfigs(repo, createdApp.app.id)).toBe(2);
    for (const environment of createdApp.environments) {
      expect(
        await repo.credentials.listClientKeys(envScope(createdApp.app.id, environment.id)),
      ).toHaveLength(1);
    }
  });
});

describe("flag delete guards and cascade cleanup", () => {
  it("blocks delete when a draft Experiment references the Flag", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const repo = createRepository(h.bindings.d1);
    await repo.experiments.experiments.insert(envScope(createdApp.app.id, dev?.id ?? ""), {
      id: "exp_draft_flag_delete",
      appId: createdApp.app.id,
      environmentId: dev?.id ?? "",
      key: "draft-flag-delete",
      flagId: flag.id,
      name: "Draft flag delete guard",
      status: "draft",
      targetingKeyField: "targetingKey",
      targetingKeyType: "user",
      metrics: "[]",
      guardrailMetrics: "[]",
      dimensions: "[]",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });

    const del = await request(h, "DELETE", `/apps/${createdApp.app.id}/flags/${flag.id}`, jwt);
    expect(del.status).toBe(409);
    expect((await del.json()) as { code: string }).toMatchObject({ code: "RESOURCE_NOT_EMPTY" });
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeTruthy();
  });

  it("blocks delete when an ended Experiment references the Flag", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const repo = createRepository(h.bindings.d1);
    await repo.experiments.experiments.insert(envScope(createdApp.app.id, dev?.id ?? ""), {
      id: "exp_ended_flag_delete",
      appId: createdApp.app.id,
      environmentId: dev?.id ?? "",
      key: "ended-flag-delete",
      flagId: flag.id,
      name: "Ended flag delete guard",
      status: "ended",
      targetingKeyField: "targetingKey",
      targetingKeyType: "user",
      metrics: "[]",
      guardrailMetrics: "[]",
      dimensions: "[]",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });

    const del = await request(h, "DELETE", `/apps/${createdApp.app.id}/flags/${flag.id}`, jwt);
    expect(del.status).toBe(409);
    expect((await del.json()) as { code: string }).toMatchObject({ code: "RESOURCE_NOT_EMPTY" });
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeTruthy();
  });
});

describe("flag delete running experiment guards", () => {
  it("returns EXPERIMENT_RUNNING when a draft Experiment precedes a running one in the same Environment", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const repo = createRepository(h.bindings.d1);
    const scope = envScope(createdApp.app.id, dev?.id ?? "");
    await insertExperiment(repo, scope, {
      id: "exp_draft_before_running",
      flagId: flag.id,
      key: "draft-before-running",
      status: "draft",
    });
    await seedRunningFlagExperiment(
      repo,
      createdApp.app.id,
      dev?.id ?? "",
      flag.id,
      "running-same-env",
    );

    const del = await request(h, "DELETE", `/apps/${createdApp.app.id}/flags/${flag.id}`, jwt);
    expect(del.status).toBe(409);
    expect((await del.json()) as { code: string }).toMatchObject({ code: "EXPERIMENT_RUNNING" });
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeTruthy();
  });

  it("returns EXPERIMENT_RUNNING when an ended Experiment precedes a running one in the same Environment", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const repo = createRepository(h.bindings.d1);
    const scope = envScope(createdApp.app.id, dev?.id ?? "");
    await insertExperiment(repo, scope, {
      id: "exp_ended_before_running",
      flagId: flag.id,
      key: "ended-before-running",
      status: "ended",
    });
    await seedRunningFlagExperiment(
      repo,
      createdApp.app.id,
      dev?.id ?? "",
      flag.id,
      "running-after-ended",
    );

    const del = await request(h, "DELETE", `/apps/${createdApp.app.id}/flags/${flag.id}`, jwt);
    expect(del.status).toBe(409);
    expect((await del.json()) as { code: string }).toMatchObject({ code: "EXPERIMENT_RUNNING" });
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeTruthy();
  });

  it("returns EXPERIMENT_RUNNING when a draft Experiment in another Environment masks a running one", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    const prod = createdApp.environments.find((env) => env.key === "prod");
    expect(dev).toBeDefined();
    expect(prod).toBeDefined();
    const repo = createRepository(h.bindings.d1);
    await insertExperiment(repo, envScope(createdApp.app.id, dev?.id ?? ""), {
      id: "exp_draft_other_env",
      flagId: flag.id,
      key: "draft-other-env",
      status: "draft",
    });
    await seedRunningFlagExperiment(
      repo,
      createdApp.app.id,
      prod?.id ?? "",
      flag.id,
      "running-other-env",
    );

    const del = await request(h, "DELETE", `/apps/${createdApp.app.id}/flags/${flag.id}`, jwt);
    expect(del.status).toBe(409);
    expect((await del.json()) as { code: string }).toMatchObject({ code: "EXPERIMENT_RUNNING" });
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeTruthy();
  });

  it("returns EXPERIMENT_RUNNING when an ended Experiment in another Environment masks a running one", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    const prod = createdApp.environments.find((env) => env.key === "prod");
    expect(dev).toBeDefined();
    expect(prod).toBeDefined();
    const repo = createRepository(h.bindings.d1);
    await insertExperiment(repo, envScope(createdApp.app.id, dev?.id ?? ""), {
      id: "exp_ended_other_env",
      flagId: flag.id,
      key: "ended-other-env",
      status: "ended",
    });
    await seedRunningFlagExperiment(
      repo,
      createdApp.app.id,
      prod?.id ?? "",
      flag.id,
      "running-ended-other-env",
    );

    const del = await request(h, "DELETE", `/apps/${createdApp.app.id}/flags/${flag.id}`, jwt);
    expect(del.status).toBe(409);
    expect((await del.json()) as { code: string }).toMatchObject({ code: "EXPERIMENT_RUNNING" });
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeTruthy();
  });
});

describe("flag delete cascade cleanup", () => {
  it("cascade-deletes Environment configs and KV snapshots when a Flag is deleted", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);

    const del = await request(h, "DELETE", `/apps/${createdApp.app.id}/flags/${flag.id}`, jwt);
    expect(del.status).toBe(200);

    for (const environment of createdApp.environments) {
      expect(
        await repo.flags.getFlagConfig(envScope(createdApp.app.id, environment.id), flag.id),
      ).toBeNull();
      expect(
        await h.bindings.configKv.get(
          flagConfigKey(createdApp.app.id, environment.id, flag.key),
          "text",
        ),
      ).toBeNull();
    }
  });

  it("rolls back every D1 delete when an Experiment races into the delete transaction", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const repo = createRepository(h.bindings.d1);
    const originalDelete = repo.flags.deleteFlagCascade.bind(repo.flags);
    repo.flags.deleteFlagCascade = async (scope, flagId, environmentIds) => {
      await insertExperiment(repo, envScope(createdApp.app.id, dev?.id ?? ""), {
        id: "exp_race_flag_delete",
        flagId,
        key: "race-flag-delete",
        status: "draft",
      });
      return originalDelete(scope, flagId, environmentIds);
    };
    h.app = makeAppForRepo(h, repo, configStoreAccess(h.bindings), h.bindings.credentialKv);

    const del = await request(h, "DELETE", `/apps/${createdApp.app.id}/flags/${flag.id}`, jwt);
    expect(del.status).toBe(500);
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeTruthy();
    expect(await repo.flags.listVariants(appScope(createdApp.app.id), flag.id)).not.toHaveLength(0);
    for (const environment of createdApp.environments) {
      expect(
        await repo.flags.getFlagConfig(envScope(createdApp.app.id, environment.id), flag.id),
      ).toBeTruthy();
    }
  });
});

describe("flag configuration onboarding path", () => {
  it("supports create → configure dev → verify → evaluate through real API paths", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
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

    const clientKeyRes = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/envs/${dev?.id}/client-key`,
      jwt,
    );
    expect(clientKeyRes.status).toBe(200);
    const clientKey = (await clientKeyRes.json()) as { keyMaterial: string };

    const evaluationApp = createEvaluationApp({
      authResolver: async () => ({ ok: false, reason: "UNAUTHORIZED" }),
      dataPlaneAuthResolver: makeDataPlaneAuthResolver(h.bindings.credentialKv),
      rateLimiter: () => ({ limited: false }),
      provider: new KvProvider(h.bindings.configKv),
      assignmentStore: new RecordingAssignmentStore(),
      exposureAssembly: {
        saltStore: new StaticSaltStore(),
        sourceId: "lifecycle-test",
        newEventId: () => "evt-lifecycle-1",
        now: () => new Date(Date.parse(NOW_ISO)),
      },
      evaluationCommitSink: new RecordingEvaluationCommitSink(
        new RecordingExposureSink(),
        new RecordingEvaluationUsageSink(),
      ),
      evaluationUsageSink: new RecordingEvaluationUsageSink(),
    });

    const verifyRes = await evaluationApp.request("/api/sdk/verify", {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientKey.keyMaterial}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        flagKey: flag.key,
        targetingKey: "user-lifecycle-1",
        idType: "user",
        attributes: {},
      }),
    });
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toMatchObject({
      variantName: "control",
      value: false,
      reason: "DEFAULT",
    });

    const evaluateRes = await evaluationApp.request("/api/sdk/evaluate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientKey.keyMaterial}`,
        "content-type": "application/json",
        "idempotency-key": "lifecycle-eval-1",
      },
      body: JSON.stringify({
        flagKey: flag.key,
        targetingKey: "user-lifecycle-1",
        idType: "user",
        attributes: {},
      }),
    });
    expect(evaluateRes.status).toBe(200);
    expect(await evaluateRes.json()).toMatchObject({
      variant: false,
    });
  });
});

function configStoreAccess(bindings: MigratedLocalBindings) {
  const repo = createRepository(bindings.d1);
  const nudges: unknown[] = [];
  const store = makeConfigStore({
    repo,
    kv: bindings.configKv,
    broadcaster: { broadcast: (nudge) => void nudges.push(nudge) },
    now: () => new Date(Date.parse(NOW_ISO)),
  });
  return {
    writerFor: (_appId: string, _environmentId: string) => store,
    liveUpdatesFor: () => ({
      connect: async () => new Response("test live updates unavailable", { status: 503 }),
    }),
    nudges,
  };
}

async function countFlagConfigs(
  repo: ReturnType<typeof createRepository>,
  appId: string,
): Promise<number> {
  const environments = await repo.identity.listEnvironments(appScope(appId));
  const counts = await Promise.all(
    environments.map((environment) =>
      repo.flags.flagConfigs.findMany(envScope(appId, environment.id)).then((rows) => rows.length),
    ),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

async function lifecycleOrgToken(h: LifecycleHarness): Promise<string> {
  return h.signer.sign({
    sub: LIFECYCLE_OWNER,
    iss: "https://auth.splitch.test",
    aud: "https://cp.splitch.test",
    iat: Math.floor(Date.parse(NOW_ISO) / 1000),
    exp: Math.floor(Date.parse(NOW_ISO) / 1000) + 3600,
    scopes: [`org:${LIFECYCLE_ORG.orgId}:owner`],
  });
}

async function lifecycleAppToken(h: LifecycleHarness, appId: string): Promise<string> {
  return h.signer.sign({
    sub: LIFECYCLE_OWNER,
    iss: "https://auth.splitch.test",
    aud: "https://cp.splitch.test",
    iat: Math.floor(Date.parse(NOW_ISO) / 1000),
    exp: Math.floor(Date.parse(NOW_ISO) / 1000) + 3600,
    scopes: [`app:${appId}:owner`],
  });
}

async function lifecycleCreateDefaultApp(h: LifecycleHarness) {
  const res = await request(
    h,
    "POST",
    `/orgs/${LIFECYCLE_ORG.orgId}/apps`,
    await lifecycleOrgToken(h),
    {
      organizationId: LIFECYCLE_ORG.orgId,
      name: "Checkout",
      key: "checkout",
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
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

function faultingCredentialProvisionKv(base: KVNamespace): KVNamespace {
  let puts = 0;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return async (...args: Parameters<KVNamespace["put"]>) => {
          puts += 1;
          if (puts === 1) throw new Error("KV unavailable");
          return target.put(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function insertExperiment(
  repo: ReturnType<typeof createRepository>,
  scope: ReturnType<typeof envScope>,
  input: { id: string; flagId: string; key: string; status: "draft" | "ended" | "running" },
): Promise<void> {
  await repo.experiments.experiments.insert(scope, {
    id: input.id,
    appId: scope.appId,
    environmentId: scope.environmentId,
    key: input.key,
    flagId: input.flagId,
    name: input.key,
    status: input.status,
    targetingKeyField: "targetingKey",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
}

async function seedRunningFlagExperiment(
  repo: ReturnType<typeof createRepository>,
  appId: string,
  environmentId: string,
  flagId: string,
  suffix: string,
): Promise<void> {
  const scope = envScope(appId, environmentId);
  const experimentId = `exp_running_${suffix}`;
  const runId = `run_running_${suffix}`;
  await repo.experiments.experiments.insert(scope, {
    id: experimentId,
    appId,
    environmentId,
    key: `running-${suffix}`,
    flagId,
    name: `Running ${suffix}`,
    status: "running",
    targetingKeyField: "targetingKey",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: runId,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.experiments.runs.insert(scope, {
    id: runId,
    appId,
    environmentId,
    experimentId,
    runNumber: 1,
    status: "running",
    targetingKeyField: "targetingKey",
    targetingKeyType: "user",
    salt: `salt_${suffix}`,
    allocation: JSON.stringify({ control: 100 }),
    variantSet: "[]",
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: `hash_${suffix}`,
    startedAt: NOW_ISO,
    createdAt: NOW_ISO,
  });
}
