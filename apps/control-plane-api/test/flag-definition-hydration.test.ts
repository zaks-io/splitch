import type { HydratedFlagResponse } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { FLAG_LIST_READ_LIMIT } from "../src/overview-thresholds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("hydrated Flag definition reads", () => {
  it("returns one Flag with every Environment's distinct full Configuration", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = requiredEnvironment(createdApp.environments, "dev");
    const prod = requiredEnvironment(createdApp.environments, "prod");
    const repo = createRepository(h.bindings.d1);

    await seedEnvironmentConfiguration(repo, createdApp.app.id, dev.id, flag, {
      enabled: true,
      availableVariantNames: ["control"],
      rollout: { percentage: 17, salt: "dev-baseline-salt" },
      rule: {
        id: "rule_dev_region",
        priority: 1,
        conditions: [{ attribute: "region", operator: "eq", value: "us" }],
        variantId: requiredVariant(flag, "control").id,
        percentageRollout: { percentage: 13, salt: "dev-rule-salt" },
      },
      experiment: { id: "exp_dev_conversion", key: "dev-conversion", name: "Dev display name" },
    });
    await seedEnvironmentConfiguration(repo, createdApp.app.id, prod.id, flag, {
      enabled: false,
      availableVariantNames: ["treatment"],
      rollout: { percentage: 83, salt: "prod-baseline-salt" },
      rule: {
        id: "rule_prod_plan",
        priority: 7,
        conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
        variantId: requiredVariant(flag, "treatment").id,
        percentageRollout: { percentage: 91, salt: "prod-rule-salt" },
      },
      experiment: {
        id: "exp_prod_revenue",
        key: "prod-revenue",
        name: "Prod display name",
      },
    });

    const response = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/flags/${flag.id}?include=config`,
      jwt,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as HydratedFlagResponse;

    expect(body).toMatchObject({ id: flag.id, key: flag.key, variants: flag.variants });
    expect(body.configurations).toEqual([
      {
        environmentId: dev.id,
        enabled: true,
        availableVariantNames: ["control"],
        targetingRules: [
          {
            id: "rule_dev_region",
            flagId: flag.id,
            priority: 1,
            conditions: [{ attribute: "region", operator: "eq", value: "us" }],
            variantId: requiredVariant(flag, "control").id,
            percentageRollout: { percentage: 13, salt: "dev-rule-salt" },
          },
        ],
        rollout: { percentage: 17, salt: "dev-baseline-salt" },
        experiment: { id: "exp_dev_conversion", key: "dev-conversion" },
      },
      {
        environmentId: prod.id,
        enabled: false,
        availableVariantNames: ["treatment"],
        targetingRules: [
          {
            id: "rule_prod_plan",
            flagId: flag.id,
            priority: 7,
            conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
            variantId: requiredVariant(flag, "treatment").id,
            percentageRollout: { percentage: 91, salt: "prod-rule-salt" },
          },
        ],
        rollout: { percentage: 83, salt: "prod-baseline-salt" },
        experiment: { id: "exp_prod_revenue", key: "prod-revenue" },
      },
    ]);
    expect(body.configurations.every((config) => !("appId" in config))).toBe(true);
    expect(body.configurations.every((config) => !("updatedBy" in config))).toBe(true);
    expect(
      body.configurations.every((config) => !config.experiment || !("name" in config.experiment)),
    ).toBe(true);

    const subset = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/flags/${flag.id}?include=config&envs=${prod.id}`,
      jwt,
    );
    expect(subset.status).toBe(200);
    expect(((await subset.json()) as HydratedFlagResponse).configurations).toEqual([
      body.configurations[1],
    ]);
  });

  it("keeps bare get and list response bytes identical to the existing envelope", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const create = await request(
      h,
      "POST",
      `/apps/${createdApp.app.id}/flags`,
      jwt,
      baseFlag(createdApp.app.id),
    );
    expect(create.status).toBe(200);
    const existingEnvelopeBytes = await create.text();

    const get = await request(h, "GET", `/apps/${createdApp.app.id}/flags/checkout-redesign`, jwt);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(existingEnvelopeBytes);

    const list = await request(h, "GET", `/apps/${createdApp.app.id}/flags`, jwt);
    expect(list.status).toBe(200);
    expect(await list.text()).toBe(
      JSON.stringify({
        items: [JSON.parse(existingEnvelopeBytes)],
        readTruncated: false,
        readLimit: FLAG_LIST_READ_LIMIT,
        cursor: null,
      }),
    );
  });

  it("fails loud when one Environment has two running Experiments for the Flag", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = requiredEnvironment(createdApp.environments, "dev");
    const repo = createRepository(h.bindings.d1);
    const scope = envScope(createdApp.app.id, dev.id);
    for (const suffix of ["first", "second"]) {
      await repo.experiments.experiments.insert(scope, {
        id: `exp_hydration_duplicate_${suffix}`,
        appId: createdApp.app.id,
        environmentId: dev.id,
        key: `hydration-duplicate-${suffix}`,
        flagId: flag.id,
        name: `Hydration duplicate ${suffix}`,
        status: "running",
        targetingKeyField: "userId",
        targetingKeyType: "user",
        metrics: "[]",
        guardrailMetrics: "[]",
        dimensions: "[]",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      });
    }

    const response = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/flags/${flag.id}?include=config`,
      jwt,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("names the Flag and Environment when a Configuration row is missing", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const prod = requiredEnvironment(createdApp.environments, "prod");

    await h.bindings.d1
      .prepare("DELETE FROM flag_configs WHERE app_id = ? AND environment_id = ? AND flag_id = ?")
      .bind(createdApp.app.id, prod.id, flag.id)
      .run();

    const response = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/flags/${flag.id}?include=config`,
      jwt,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: `Flag ${flag.id} has no Configuration in Environment ${prod.id}`,
      details: { fault: "FLAG_CONFIGURATION_MISSING" },
    });
  });

  it("makes a foreign Environment id indistinguishable from a nonexistent id", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const repo = createRepository(h.bindings.d1);
    const foreignEnvironmentId = "env_foreign_hydrated_read";
    await repo.identity.environments.insert(appScope("app_existing_flag_definition"), {
      id: foreignEnvironmentId,
      appId: "app_existing_flag_definition",
      key: "foreign-hydrated-read",
      name: "Foreign hydrated read",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });

    const foreign = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/flags/${flag.id}?include=config&envs=${foreignEnvironmentId}`,
      jwt,
    );
    const missing = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/flags/${flag.id}?include=config&envs=env_does_not_exist`,
      jwt,
    );

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });
});

type CreatedFlag = Awaited<ReturnType<typeof createFlag>>;

function requiredEnvironment(environments: Array<{ id: string; key: string }>, key: string) {
  const environment = environments.find((candidate) => candidate.key === key);
  if (!environment) throw new Error(`fixture App is missing ${key} Environment`);
  return environment;
}

function requiredVariant(flag: CreatedFlag, name: string) {
  const variant = flag.variants.find((candidate) => candidate.name === name);
  if (!variant) throw new Error(`fixture Flag is missing ${name} Variant`);
  return variant;
}

async function seedEnvironmentConfiguration(
  repo: ReturnType<typeof createRepository>,
  appId: string,
  environmentId: string,
  flag: CreatedFlag,
  input: {
    enabled: boolean;
    availableVariantNames: string[];
    rollout: { percentage: number; salt: string };
    rule: {
      id: string;
      priority: number;
      conditions: Array<{ attribute: string; operator: "eq"; value: string }>;
      variantId: string;
      percentageRollout: { percentage: number; salt: string };
    };
    experiment: { id: string; key: string; name: string };
  },
) {
  const scope = envScope(appId, environmentId);
  const updated = await repo.flags.updateFlagConfig(scope, flag.id, {
    enabled: input.enabled,
    availableVariantNames: JSON.stringify(input.availableVariantNames),
    rollout: JSON.stringify(input.rollout),
    updatedAt: NOW_ISO,
    updatedBy: "user_hydration_fixture",
    updatedVia: "control-plane",
  });
  if (!updated) throw new Error("fixture Flag Configuration is missing");
  await repo.flags.targetingRules.insert(scope, {
    ...input.rule,
    appId,
    environmentId,
    flagId: flag.id,
    conditions: JSON.stringify(input.rule.conditions),
    percentageRollout: JSON.stringify(input.rule.percentageRollout),
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.experiments.experiments.insert(scope, {
    ...input.experiment,
    appId,
    environmentId,
    flagId: flag.id,
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
}
