import { flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFlag, makeAppForRepo, NOW_ISO, request } from "../src/flag-definition-test-harness";
import {
  configStoreAccess,
  insertExperiment,
  type LifecycleHarness,
  lifecycleAppToken,
  lifecycleCreateDefaultApp,
  seedRunningFlagExperiment,
  setup,
} from "./flag-config-lifecycle-harness";

let h: LifecycleHarness;

beforeEach(async () => {
  h = await setup();
});

afterEach(async () => h.bindings.dispose());

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
