import { controlPlaneFlagConfigKey, flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowAllPolicies,
  createFlag,
  makeAppForRepo,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import {
  configStoreAccess,
  insertExperiment,
  type LifecycleHarness,
  lifecycleAppToken,
  lifecycleCreateDefaultApp,
  setup,
} from "./flag-config-lifecycle-harness";

let h: LifecycleHarness;

beforeEach(async () => {
  h = await setup();
});

afterEach(async () => h.bindings.dispose());

describe("flag delete cascade cleanup", () => {
  it("cascade-deletes Flag Configurations and KV snapshots when a Flag is deleted", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    // This suite is about the cascade, not the Approval gate a `confirm`
    // Environment Policy puts in front of it.
    await allowAllPolicies(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);

    const del = await request(
      h,
      "DELETE",
      `/apps/${createdApp.app.id}/flags/${flag.id}`,
      jwt,
      undefined,
      `idem-delete-flag-${crypto.randomUUID()}`,
    );
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
});

describe("flag delete orphan snapshot cleanup", () => {
  it("deletes a Flag when one Environment has no Flag Configuration", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    await allowAllPolicies(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);
    const missingEnvironment = createdApp.environments[0];
    if (!missingEnvironment) throw new Error("expected an Environment");
    const missingScope = envScope(createdApp.app.id, missingEnvironment.id);
    await repo.flags.removeFlagConfig(missingScope, flag.id);
    expect(
      await h.bindings.configKv.get(
        flagConfigKey(createdApp.app.id, missingEnvironment.id, flag.key),
        "text",
      ),
    ).not.toBeNull();
    expect(
      await h.bindings.configKv.get(
        controlPlaneFlagConfigKey(createdApp.app.id, missingEnvironment.id, flag.id),
        "text",
      ),
    ).toContain('"state":"present"');

    const del = await request(
      h,
      "DELETE",
      `/apps/${createdApp.app.id}/flags/${flag.id}`,
      jwt,
      undefined,
      `idem-delete-incomplete-flag-${crypto.randomUUID()}`,
    );

    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeNull();
    for (const environment of createdApp.environments) {
      expect(
        await h.bindings.configKv.get(
          flagConfigKey(createdApp.app.id, environment.id, flag.key),
          "text",
        ),
      ).toBeNull();
      expect(
        await h.bindings.configKv.get(
          controlPlaneFlagConfigKey(createdApp.app.id, environment.id, flag.id),
          "text",
        ),
      ).toContain('"state":"deleted"');
    }
  });
});

describe("flag delete cascade transaction", () => {
  it("rolls back every D1 delete when an Experiment races into the delete transaction", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    await allowAllPolicies(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const repo = createRepository(h.bindings.d1);
    const originalDelete = repo.flags.deleteFlagCascade.bind(repo.flags);
    const access = configStoreAccess(h.bindings);
    if (!dev) throw new Error("test dev Environment is missing");
    expect(
      await access.writerFor(createdApp.app.id, dev.id).resyncFlagConfig({
        appId: createdApp.app.id,
        environmentId: dev.id,
        flagId: flag.id,
      }),
    ).toMatchObject({ ok: true, snapshotRevision: 1 });
    repo.flags.deleteFlagCascade = async (scope, flagId, environmentIds) => {
      await insertExperiment(repo, envScope(createdApp.app.id, dev?.id ?? ""), {
        id: "exp_race_flag_delete",
        flagId,
        key: "race-flag-delete",
        status: "draft",
      });
      return originalDelete(scope, flagId, environmentIds);
    };
    h.app = makeAppForRepo(h, repo, access, h.bindings.credentialKv);

    const del = await request(
      h,
      "DELETE",
      `/apps/${createdApp.app.id}/flags/${flag.id}`,
      jwt,
      undefined,
      `idem-delete-flag-${crypto.randomUUID()}`,
    );
    expect(del.status).toBe(500);
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeTruthy();
    expect(
      await repo.experiments.peekExperiment(
        envScope(createdApp.app.id, dev.id),
        "exp_race_flag_delete",
      ),
    ).toBeTruthy();
    expect(await repo.flags.listVariants(appScope(createdApp.app.id), flag.id)).not.toHaveLength(0);
    for (const environment of createdApp.environments) {
      expect(
        await repo.flags.getFlagConfig(envScope(createdApp.app.id, environment.id), flag.id),
      ).toBeTruthy();
    }
    expect(
      await h.bindings.configKv.get(
        controlPlaneFlagConfigKey(createdApp.app.id, dev.id, flag.id),
        "text",
      ),
    ).toContain('"state":"present"');
    expect(
      await access.writerFor(createdApp.app.id, dev.id).writeFlagConfig({
        appId: createdApp.app.id,
        environmentId: dev.id,
        flagId: flag.id,
        enabled: true,
        actor: { ref: "user_spl_526", via: "session" },
      }),
    ).toMatchObject({ ok: true, config: { enabled: true }, snapshotRevision: 2 });
  });
});

describe("flag delete cascade related-record cleanup", () => {
  it("cascade-deletes archived Experiments (and their Runs) when deleting the Flag", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    await allowAllPolicies(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const repo = createRepository(h.bindings.d1);
    const scope = envScope(createdApp.app.id, dev?.id ?? "");
    await repo.experiments.experiments.insert(scope, {
      id: "exp_archived_flag_delete",
      appId: createdApp.app.id,
      environmentId: dev?.id ?? "",
      key: "archived-flag-delete",
      flagId: flag.id,
      name: "Archived flag delete cascade",
      status: "archived",
      targetingKeyField: "targetingKey",
      targetingKeyType: "user",
      metrics: "[]",
      guardrailMetrics: "[]",
      dimensions: "[]",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    await repo.experiments.runs.insert(scope, {
      id: "run_archived_flag_delete",
      appId: createdApp.app.id,
      environmentId: dev?.id ?? "",
      experimentId: "exp_archived_flag_delete",
      runNumber: 1,
      status: "ended",
      targetingKeyField: "targetingKey",
      targetingKeyType: "user",
      salt: "archived-flag-delete-salt",
      allocation: JSON.stringify({ control: 100 }),
      variantSet: JSON.stringify([{ id: flag.defaultVariantId, name: "control", value: false }]),
      controlVariantId: flag.defaultVariantId,
      targetingRules: "[]",
      confidenceLevel: 0.95,
      decisionFamily: "[]",
      guardrailDecisions: "[]",
      configHash: "sha256:archived-flag-delete",
      startedAt: NOW_ISO,
      endedAt: NOW_ISO,
      createdAt: NOW_ISO,
    });

    const del = await request(
      h,
      "DELETE",
      `/apps/${createdApp.app.id}/flags/${flag.id}`,
      jwt,
      undefined,
      `idem-delete-flag-${crypto.randomUUID()}`,
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect(await repo.flags.getFlag(appScope(createdApp.app.id), flag.id)).toBeNull();
    expect(await repo.experiments.peekExperiment(scope, "exp_archived_flag_delete")).toBeNull();
    expect(await repo.experiments.listRunsForExperiment(scope, "exp_archived_flag_delete")).toEqual(
      [],
    );
  });
});
