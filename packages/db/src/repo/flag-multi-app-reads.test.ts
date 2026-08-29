import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope, multiAppScope } from "../index";
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
    await repo.flags.flagConfigs.insert(envScope(tenant.appId, tenant.environmentId), {
      id: `cfg_${tenant.flagId}`,
      appId: tenant.appId,
      environmentId: tenant.environmentId,
      flagId: tenant.flagId,
      availableVariantNames: JSON.stringify(["control"]),
      defaultVariantId: tenant.variantId,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
});

afterEach(async () => local.dispose());

describe("membership-scoped multi-App Flag reads", () => {
  it("returns only the minted App set in App then Flag-key order", async () => {
    const both = multiAppScope([seed.b.appId, seed.a.appId]);

    const [rows, descriptors, environments, variants, configs] = await Promise.all([
      repo.flags.listFlagPageAcrossApps(both, 10),
      repo.flags.listAppDescriptors(both),
      repo.flags.listEnvironmentsAcrossApps(both),
      repo.flags.listVariantsForFlagsAcrossApps(both, [seed.a.flagId, seed.b.flagId]),
      repo.flags.listFlagConfigsAcrossApps(both, [seed.a.flagId, seed.b.flagId]),
    ]);

    expect(rows.map((row) => [row.appId, row.key])).toEqual([
      [seed.a.appId, seed.a.flagKey],
      [seed.b.appId, seed.b.flagKey],
    ]);
    expect(descriptors.map((row) => row.appId)).toEqual([seed.a.appId, seed.b.appId]);
    expect(environments.map((row) => row.appId)).toEqual([seed.a.appId, seed.b.appId]);
    expect([...variants.keys()].sort()).toEqual([seed.a.flagId, seed.b.flagId]);
    expect(configs.map((row) => row.appId).sort()).toEqual([seed.a.appId, seed.b.appId]);
  });

  it("does not return rows from a non-member App even when foreign Flag ids are supplied", async () => {
    const member = multiAppScope([seed.a.appId]);

    const [rows, variants, configs] = await Promise.all([
      repo.flags.listFlagPageAcrossApps(member, 10),
      repo.flags.listVariantsForFlagsAcrossApps(member, [seed.a.flagId, seed.b.flagId]),
      repo.flags.listFlagConfigsAcrossApps(member, [seed.a.flagId, seed.b.flagId]),
    ]);

    expect(rows.map((row) => row.id)).toEqual([seed.a.flagId]);
    expect([...variants.keys()]).toEqual([seed.a.flagId]);
    expect(configs.map((row) => row.flagId)).toEqual([seed.a.flagId]);
  });

  it("returns empty results without preparing SQL for an empty membership set", async () => {
    let prepareCalls = 0;
    const countedD1 = new Proxy(local.d1, {
      get(target, property, receiver) {
        if (property === "prepare") prepareCalls += 1;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const countedRepo = createRepository(countedD1);
    const empty = multiAppScope([]);

    const results = await Promise.all([
      countedRepo.flags.listFlagPageAcrossApps(empty, 10),
      countedRepo.flags.listAppDescriptors(empty),
      countedRepo.flags.listEnvironmentsAcrossApps(empty),
      countedRepo.flags.listVariantsForFlagsAcrossApps(empty, [seed.a.flagId]),
      countedRepo.flags.listFlagConfigsAcrossApps(empty, [seed.a.flagId]),
      countedRepo.flags.listTargetingRulesAcrossApps(empty, [seed.a.flagId]),
      countedRepo.flags.listRunningExperimentsAcrossApps(empty, [seed.a.flagId]),
    ]);

    expect(results.every((result) => result instanceof Map || result.length === 0)).toBe(true);
    expect(prepareCalls).toBe(0);
  });

  it("keeps query count constant from one member App to multiple member Apps", async () => {
    let prepareCalls = 0;
    const countedD1 = new Proxy(local.d1, {
      get(target, property, receiver) {
        if (property === "prepare") prepareCalls += 1;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const countedRepo = createRepository(countedD1);
    const read = async (appIds: readonly string[], flagIds: readonly string[]) => {
      prepareCalls = 0;
      const scope = multiAppScope(appIds);
      await Promise.all([
        countedRepo.flags.listFlagPageAcrossApps(scope, 10),
        countedRepo.flags.listAppDescriptors(scope),
        countedRepo.flags.listEnvironmentsAcrossApps(scope),
        countedRepo.flags.listVariantsForFlagsAcrossApps(scope, flagIds),
        countedRepo.flags.listFlagConfigsAcrossApps(scope, flagIds),
        countedRepo.flags.listTargetingRulesAcrossApps(scope, flagIds),
        countedRepo.flags.listRunningExperimentsAcrossApps(scope, flagIds),
      ]);
      return prepareCalls;
    };

    const oneApp = await read([seed.a.appId], [seed.a.flagId]);
    const twoApps = await read([seed.a.appId, seed.b.appId], [seed.a.flagId, seed.b.flagId]);
    expect(oneApp).toBeGreaterThan(0);
    expect(twoApps).toBe(oneApp);
  });

  it("rejects a forged multi-App scope", async () => {
    const forged = { appIds: [seed.a.appId] } as never;

    await expect(repo.flags.listFlagPageAcrossApps(forged, 10)).rejects.toThrow(
      /not minted by multiAppScope/,
    );
  });

  it("keeps per-App reads unchanged", async () => {
    const row = await repo.flags.getFlag(appScope(seed.a.appId), seed.a.flagId);
    expect(row?.id).toBe(seed.a.flagId);
  });
});
