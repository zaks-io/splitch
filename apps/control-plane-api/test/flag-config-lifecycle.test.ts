import { flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeFlagConfigsForFlag } from "../src/flag-config-lifecycle";
import {
  baseFlag,
  createFlag,
  makeAppForRepo,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import {
  configStoreAccess,
  countFlagConfigs,
  faultingCredentialProvisionKv,
  faultingRepo,
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

  it("resumes Flag creation when config initialization fails partway", async () => {
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

    const idempotencyKey = `idem-create-flag-${crypto.randomUUID()}`;
    const body = baseFlag(createdApp.app.id);
    const res = await h.app.request(`/apps/${createdApp.app.id}/flags`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(500);
    expect(
      (await repo.flags.flags.findMany(appScope(createdApp.app.id))).some(
        (row) => row.key === "checkout-redesign",
      ),
    ).toBe(true);

    h.app = makeAppForRepo(h, repo, configStoreAccess(h.bindings), h.bindings.credentialKv);
    const recovered = await h.app.request(`/apps/${createdApp.app.id}/flags`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    expect(recovered.status).toBe(200);
    for (const environment of environments) {
      expect(
        await repo.flags.flagConfigs.findMany(envScope(createdApp.app.id, environment.id)),
      ).toHaveLength(1);
      expect(
        await h.bindings.configKv.get(
          flagConfigKey(createdApp.app.id, environment.id, "checkout-redesign"),
          "text",
        ),
      ).not.toBeNull();
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
