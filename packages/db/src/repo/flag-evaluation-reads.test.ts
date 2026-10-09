import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { seedSiblingEnvironment, seedTwoTenants } from "./test-seed";

const NOW = "2026-01-01T00:00:00.000Z";
const SIBLING_ENVIRONMENT_ID = "env_a_sibling";
const MOVED_FLAG_ID = "flag_a_moved";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: Awaited<ReturnType<typeof seedTwoTenants>>;

beforeAll(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
  await seedSiblingEnvironment(local.d1, seed.a, SIBLING_ENVIRONMENT_ID);
  for (const tenant of [seed.a, seed.b]) {
    await seedConfiguration(tenant.appId, tenant.environmentId, tenant.flagId, tenant.variantId);
  }
  await seedConfiguration(seed.a.appId, SIBLING_ENVIRONMENT_ID, seed.a.flagId, seed.a.variantId);
  await local.d1
    .prepare("UPDATE experiments SET status = 'running' WHERE app_id = ? AND id = ?")
    .bind(seed.a.appId, seed.a.experimentId)
    .run();
});

afterAll(async () => {
  await local.dispose();
});

describe("readFlagSnapshotInputsByKey", () => {
  it("reads one Environment's snapshot rows by Flag key", async () => {
    const rows = await repo.flagEvaluation.readFlagSnapshotInputsByKey(
      envScope(seed.a.appId, seed.a.environmentId),
      seed.a.flagKey,
    );

    expect(rows).toMatchObject({
      flag: { id: seed.a.flagId },
      config: { environmentId: seed.a.environmentId, flagId: seed.a.flagId },
      variants: [{ id: seed.a.variantId }],
      targetingRules: [{ id: ruleId(seed.a.environmentId), flagId: seed.a.flagId }],
      runningExperiment: { id: seed.a.experimentId },
    });
  });

  it("returns null for another App's Flag key", async () => {
    await expect(
      repo.flagEvaluation.readFlagSnapshotInputsByKey(
        envScope(seed.a.appId, seed.a.environmentId),
        seed.b.flagKey,
      ),
    ).resolves.toBeNull();
  });

  it("keeps another Environment's rows out", async () => {
    const rows = await repo.flagEvaluation.readFlagSnapshotInputsByKey(
      envScope(seed.a.appId, SIBLING_ENVIRONMENT_ID),
      seed.a.flagKey,
    );

    expect(rows).toMatchObject({
      config: { environmentId: SIBLING_ENVIRONMENT_ID },
      targetingRules: [{ id: ruleId(SIBLING_ENVIRONMENT_ID) }],
      runningExperiment: null,
    });
  });

  it("issues all five reads before any completes", async () => {
    const gate = gatedD1(local.d1, () => true);
    const read = createRepository(gate.d1).flagEvaluation.readFlagSnapshotInputsByKey(
      envScope(seed.a.appId, seed.a.environmentId),
      seed.a.flagKey,
    );

    await vi.waitFor(() => expect(gate.held()).toBe(5));
    gate.release();

    await expect(read).resolves.toMatchObject({ flag: { id: seed.a.flagId } });
  });

  it("reports a key that moved to another Flag between statements", async () => {
    await seedMovedFlag();
    const gate = gatedD1(local.d1, (sql) => !/^select [^(]* from "flags"/u.test(sql));
    const read = createRepository(gate.d1).flagEvaluation.readFlagSnapshotInputsByKey(
      envScope(seed.a.appId, seed.a.environmentId),
      seed.a.flagKey,
    );
    await vi.waitFor(() => expect(gate.held()).toBe(4));

    await moveKey(seed.a.flagKey, seed.a.flagId, MOVED_FLAG_ID);
    gate.release();

    await expect(read).resolves.toBe("moved");
  });
});

function ruleId(environmentId: string): string {
  return `rule_${environmentId}`;
}

async function seedConfiguration(
  appId: string,
  environmentId: string,
  flagId: string,
  variantId: string,
): Promise<void> {
  const scope = envScope(appId, environmentId);
  await repo.flags.flagConfigs.insert(scope, {
    id: `config_${environmentId}_${flagId}`,
    appId,
    environmentId,
    flagId,
    enabled: true,
    availableVariantNames: "[]",
    defaultVariantId: variantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.targetingRules.insert(scope, {
    id: flagId === MOVED_FLAG_ID ? `rule_${MOVED_FLAG_ID}` : ruleId(environmentId),
    appId,
    environmentId,
    flagId,
    priority: 0,
    conditions: "[]",
    variantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedMovedFlag(): Promise<void> {
  await repo.flags.flags.insert(appScope(seed.a.appId), {
    lifecycleClass: "ops",
    id: MOVED_FLAG_ID,
    appId: seed.a.appId,
    key: "flag-key-a-moved",
    name: "A re-created Flag",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.addVariant(appScope(seed.a.appId), MOVED_FLAG_ID, {
    id: "var_a_moved",
    name: "control",
    value: '"control"',
    createdAt: NOW,
  });
  await seedConfiguration(seed.a.appId, seed.a.environmentId, MOVED_FLAG_ID, "var_a_moved");
}

/** Hands `flagKey` from one Flag to another, as a delete and re-create would. */
async function moveKey(flagKey: string, fromFlagId: string, toFlagId: string): Promise<void> {
  await local.d1.batch([
    local.d1
      .prepare("UPDATE flags SET key = ? WHERE app_id = ? AND id = ?")
      .bind(`${flagKey}-retired`, seed.a.appId, fromFlagId),
    local.d1
      .prepare("UPDATE flags SET key = ? WHERE app_id = ? AND id = ?")
      .bind(flagKey, seed.a.appId, toFlagId),
  ]);
}

/** Holds every matching statement at execution until `release`. */
function gatedD1(d1: D1Database, holds: (sql: string) => boolean) {
  let held = 0;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        }
        if (["all", "raw", "first", "run"].includes(String(property)) && holds(sql)) {
          return async (...args: unknown[]) => {
            held += 1;
            await released;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const gated = new Proxy(d1, {
    get(target, property, receiver) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { d1: gated, held: () => held, release: () => release() };
}
