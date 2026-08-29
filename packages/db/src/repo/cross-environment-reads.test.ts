import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope, type TenantScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { seedTwoTenants } from "./test-seed";

const NOW = "2026-08-28T00:00:00.000Z";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: Awaited<ReturnType<typeof seedTwoTenants>>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
  for (const tenant of [seed.a, seed.b]) {
    const scope = envScope(tenant.appId, tenant.environmentId);
    await repo.flags.flagConfigs.insert(scope, {
      id: `cfg_${tenant.flagId}`,
      appId: tenant.appId,
      environmentId: tenant.environmentId,
      flagId: tenant.flagId,
      availableVariantNames: "[]",
      defaultVariantId: tenant.variantId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.flags.targetingRules.insert(scope, {
      id: `rule_${tenant.flagId}`,
      appId: tenant.appId,
      environmentId: tenant.environmentId,
      flagId: tenant.flagId,
      priority: 0,
      conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: tenant.appId }]),
      variantId: tenant.variantId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.experiments.experiments.update(scope, { status: "running" }, undefined);
  }
});

afterEach(async () => local.dispose());

describe("App-scoped cross-Environment reads", () => {
  it("keeps app_id stamped when the Environment IN list contains a foreign id", async () => {
    const scope = appScope(seed.a.appId);
    const environmentIds = [seed.a.environmentId, seed.b.environmentId];
    const flagIds = [seed.a.flagId, seed.b.flagId];

    const [configs, rules, experiments] = await Promise.all([
      repo.flags.listFlagConfigsByFlagIdsAcrossEnvironments(scope, flagIds, environmentIds),
      repo.flags.listTargetingRulesByFlagIdsAcrossEnvironments(scope, flagIds, environmentIds),
      repo.experiments.listRunningExperimentsForFlagsAcrossEnvironments(
        scope,
        flagIds,
        environmentIds,
      ),
    ]);

    expect(configs.map((row) => [row.appId, row.environmentId, row.flagId])).toEqual([
      [seed.a.appId, seed.a.environmentId, seed.a.flagId],
    ]);
    expect(rules.map((row) => [row.appId, row.environmentId, row.flagId])).toEqual([
      [seed.a.appId, seed.a.environmentId, seed.a.flagId],
    ]);
    expect(experiments.map((row) => [row.appId, row.environmentId, row.flagId])).toEqual([
      [seed.a.appId, seed.a.environmentId, seed.a.flagId],
    ]);
  });

  it("rejects a forged TenantScope on the cross-Environment seam", async () => {
    const forged = { appId: seed.a.appId } as unknown as TenantScope;

    await expect(
      repo.flags.listFlagConfigsByFlagIdsAcrossEnvironments(
        forged,
        [seed.a.flagId],
        [seed.a.environmentId],
      ),
    ).rejects.toThrow(/not minted by appScope/);
  });
});
