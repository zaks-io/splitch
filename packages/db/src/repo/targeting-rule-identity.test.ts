import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

const NOW = "2026-08-26T00:00:00.000Z";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
  await seedFlagConfigs();
});

afterEach(async () => {
  await local.dispose();
});

describe("Targeting Rule identity is scoped to one Flag Configuration", () => {
  it("lets two Flags in the same Environment persist the same rule id", async () => {
    const secondFlagId = "flag_a_search";
    await repo.flags.flags.insert(appScope(seed.a.appId), {
      id: secondFlagId,
      appId: seed.a.appId,
      key: "search",
      name: "Search",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.flags.flagConfigs.insert(envScope(seed.a.appId, seed.a.environmentId), {
      id: "cfg_a_search",
      appId: seed.a.appId,
      environmentId: seed.a.environmentId,
      flagId: secondFlagId,
      enabled: false,
      availableVariantNames: "[]",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const first = await replaceRules(seed.a.flagId, [rule("rule-admin")]);
    const second = await replaceRules(secondFlagId, [rule("rule-admin")]);

    expect(first).toEqual({ ok: true, config: expect.objectContaining({ flagId: seed.a.flagId }) });
    expect(second).toEqual({ ok: true, config: expect.objectContaining({ flagId: secondFlagId }) });
    expect(await ruleFlagPairs(seed.a.appId, seed.a.environmentId, "rule-admin")).toEqual([
      seed.a.flagId,
      secondFlagId,
    ]);
  });

  it("lets the same Flag keep the same rule id in two Environments", async () => {
    const otherEnvId = "env_a_dev";
    await repo.identity.environments.insert(appScope(seed.a.appId), {
      id: otherEnvId,
      appId: seed.a.appId,
      key: "dev",
      name: "Development",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.flags.flagConfigs.insert(envScope(seed.a.appId, otherEnvId), {
      id: "cfg_a_dev",
      appId: seed.a.appId,
      environmentId: otherEnvId,
      flagId: seed.a.flagId,
      enabled: false,
      availableVariantNames: "[]",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const prod = await replaceRules(seed.a.flagId, [rule("rule-admin")]);
    const dev = await repo.flags.replaceTargetingRules(
      envScope(seed.a.appId, otherEnvId),
      seed.a.flagId,
      [rule("rule-admin")],
      { updatedAt: NOW },
    );

    expect(prod.ok).toBe(true);
    expect(dev.ok).toBe(true);
    expect(await ruleEnvPairs(seed.a.appId, seed.a.flagId, "rule-admin")).toEqual([
      seed.a.environmentId,
      otherEnvId,
    ]);
  });

  it("refuses a duplicate id inside one replace as a typed conflict, not a throw", async () => {
    const conflict = await replaceRules(seed.a.flagId, [rule("rule-admin"), rule("rule-admin")]);

    expect(conflict).toEqual({ ok: false, reason: "id_conflict" });
    expect(await ruleFlagPairs(seed.a.appId, seed.a.environmentId, "rule-admin")).toEqual([]);
  });

  it("does not classify a D1 failure that only quotes the constraint text", async () => {
    const failing = createRepository(
      failingTargetingInsertD1(
        local.d1,
        "D1_ERROR: could not apply statement (UNIQUE constraint failed: targeting_rules.app_id, targeting_rules.environment_id, targeting_rules.flag_id, targeting_rules.id)",
      ),
    );

    await expect(
      failing.flags.replaceTargetingRules(
        envScope(seed.a.appId, seed.a.environmentId),
        seed.a.flagId,
        [rule("never-used")],
        { updatedAt: NOW },
      ),
    ).rejects.toThrow();
  });

  it("does not classify D1's parameter-free bind-time echo of the collision text", async () => {
    const failing = createRepository(
      failingTargetingInsertD1(
        local.d1,
        `D1_TYPE_ERROR: Type 'object' not supported for value '${POISON}'`,
      ),
    );

    await expect(
      failing.flags.replaceTargetingRules(
        envScope(seed.a.appId, seed.a.environmentId),
        seed.a.flagId,
        [rule("never-used")],
        { updatedAt: NOW },
      ),
    ).rejects.toThrow();
  });
});

const POISON =
  "UNIQUE constraint failed: targeting_rules.app_id, targeting_rules.environment_id, targeting_rules.flag_id, targeting_rules.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)";

async function seedFlagConfigs(): Promise<void> {
  await repo.flags.flagConfigs.insert(envScope(seed.a.appId, seed.a.environmentId), {
    id: "cfg_a",
    appId: seed.a.appId,
    environmentId: seed.a.environmentId,
    flagId: seed.a.flagId,
    enabled: false,
    availableVariantNames: "[]",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function rule(id: string) {
  return {
    id,
    priority: 0,
    conditions: "[]",
    segmentId: null,
    variantId: null,
    percentageRollout: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function replaceRules(flagId: string, rows: ReturnType<typeof rule>[]) {
  return repo.flags.replaceTargetingRules(
    envScope(seed.a.appId, seed.a.environmentId),
    flagId,
    rows,
    { updatedAt: NOW },
  );
}

async function ruleFlagPairs(appId: string, environmentId: string, id: string): Promise<string[]> {
  const rows = await local.d1
    .prepare(
      "SELECT flag_id FROM targeting_rules WHERE app_id = ? AND environment_id = ? AND id = ? ORDER BY flag_id",
    )
    .bind(appId, environmentId, id)
    .all<{ flag_id: string }>();
  return rows.results.map((row) => row.flag_id);
}

async function ruleEnvPairs(appId: string, flagId: string, id: string): Promise<string[]> {
  const rows = await local.d1
    .prepare(
      "SELECT environment_id FROM targeting_rules WHERE app_id = ? AND flag_id = ? AND id = ? ORDER BY environment_id",
    )
    .bind(appId, flagId, id)
    .all<{ environment_id: string }>();
  return rows.results.map((row) => row.environment_id);
}

function failingTargetingInsertD1(d1: D1Database, message: string): D1Database {
  return new Proxy(d1, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!/^insert into "targeting_rules"/.test(query)) return statement;
          return new Proxy(statement, {
            get() {
              return () => {
                throw new Error(message);
              };
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
