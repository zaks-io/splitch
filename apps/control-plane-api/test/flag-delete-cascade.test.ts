import { flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowAllPolicies,
  createFlag,
  makeAppForRepo,
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
  it("cascade-deletes Environment configs and KV snapshots when a Flag is deleted", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    // This suite is about the cascade, not the Approval gate a `confirm`
    // Environment puts in front of it.
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

  it("rolls back every D1 delete when an Experiment races into the delete transaction", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    await allowAllPolicies(h, createdApp.app.id);
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
    expect(await repo.flags.listVariants(appScope(createdApp.app.id), flag.id)).not.toHaveLength(0);
    for (const environment of createdApp.environments) {
      expect(
        await repo.flags.getFlagConfig(envScope(createdApp.app.id, environment.id), flag.id),
      ).toBeTruthy();
    }
  });
});
