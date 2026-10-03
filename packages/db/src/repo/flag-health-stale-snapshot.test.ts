import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * Stale detection must load Configuration, Targeting Rules, running Experiments,
 * and lifecycle/change-log evidence in one D1 batch so a concurrent rule
 * removal cannot invent a premature uniform_serving window.
 */

const AS_OF = "2026-07-02T12:00:00.000Z";
const NOW = "2026-06-28T00:00:00.000Z";
const CONFIG_AGED_AT = "2026-05-01T00:00:00.000Z";
const RULE_REMOVED_AT = "2026-07-02T11:59:59.000Z";
const WINDOW_START = "2026-06-02T12:00:00.000Z";

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("flagHealth.loadStaleDetectionSnapshot", () => {
  it("does not emit a premature uniform window when rules are removed before the batch", async () => {
    const flagId = "flag_stale_race";
    const variantId = `var_${flagId}`;
    await insertFlag({
      id: flagId,
      key: "stale-race",
      lifecycleClass: "release",
      createdAt: CONFIG_AGED_AT,
    });
    await local.d1
      .prepare(
        `INSERT INTO flag_configs (
           id, app_id, environment_id, flag_id, enabled, available_variant_names,
           default_variant_id, rollout, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `cfg_${flagId}`,
        seed.a.appId,
        seed.a.environmentId,
        flagId,
        JSON.stringify(["control"]),
        variantId,
        JSON.stringify({ percentage: 100, salt: "stale-race-salt" }),
        CONFIG_AGED_AT,
        CONFIG_AGED_AT,
      )
      .run();
    await local.d1
      .prepare(
        `INSERT INTO targeting_rules (
           id, app_id, environment_id, flag_id, priority, conditions,
           variant_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .bind(
        `rule_${flagId}`,
        seed.a.appId,
        seed.a.environmentId,
        flagId,
        JSON.stringify([{ attribute: "plan", operator: "eq", value: "pro" }]),
        variantId,
        CONFIG_AGED_AT,
        CONFIG_AGED_AT,
      )
      .run();

    let removed = false;
    const racingD1 = d1WithBeforeFirstBatch(local.d1, async () => {
      if (removed) return;
      removed = true;
      // Matches replaceTargetingRules: clear rules and bump Configuration.updatedAt
      // in the same competing write. Separate reads could see the old timestamp
      // with an empty rule list and invent a 60-day uniform_serving window.
      await local.d1
        .prepare(
          `DELETE FROM targeting_rules
           WHERE app_id = ? AND environment_id = ? AND flag_id = ?`,
        )
        .bind(seed.a.appId, seed.a.environmentId, flagId)
        .run();
      await local.d1
        .prepare(
          `UPDATE flag_configs
           SET updated_at = ?, version = version + 1
           WHERE app_id = ? AND environment_id = ? AND flag_id = ?`,
        )
        .bind(RULE_REMOVED_AT, seed.a.appId, seed.a.environmentId, flagId)
        .run();
    });

    const snapshot = await createRepository(racingD1).flagHealth.loadStaleDetectionSnapshot(
      appScope(seed.a.appId),
      [flagId],
      [seed.a.environmentId],
      WINDOW_START,
    );

    expect(removed).toBe(true);
    expect(
      snapshot.targetingRules.filter(
        (rule) => rule.flagId === flagId && rule.environmentId === seed.a.environmentId,
      ),
    ).toHaveLength(0);
    const config = snapshot.configs.find(
      (row) => row.flagId === flagId && row.environmentId === seed.a.environmentId,
    );
    expect(config?.updatedAt).toBe(RULE_REMOVED_AT);
    expect(config?.updatedAt).not.toBe(CONFIG_AGED_AT);
    // uniformSince would be RULE_REMOVED_AT (< 30d before AS_OF), so no
    // premature uniform_serving from the aged Configuration timestamp alone.
    const ageDays =
      (Date.parse(AS_OF) - Date.parse(config?.updatedAt ?? CONFIG_AGED_AT)) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeLessThan(30);
  });

  it("loads stale evidence through a single D1 batch", async () => {
    await local.d1
      .prepare(
        `INSERT INTO flag_configs (
           id, app_id, environment_id, flag_id, enabled, available_variant_names,
           default_variant_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 0, '[]', ?, ?, ?)`,
      )
      .bind(
        `cfg_${seed.a.flagId}`,
        seed.a.appId,
        seed.a.environmentId,
        seed.a.flagId,
        seed.a.variantId,
        NOW,
        NOW,
      )
      .run();

    let batchCalls = 0;
    let statementCount = 0;
    const countingD1 = new Proxy(local.d1, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: unknown[]) => {
            batchCalls += 1;
            statementCount = statements.length;
            expect(statements.length).toBeGreaterThanOrEqual(5);
            return Reflect.apply(target.batch, target, [statements]);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    await createRepository(countingD1).flagHealth.loadStaleDetectionSnapshot(
      appScope(seed.a.appId),
      [seed.a.flagId],
      [seed.a.environmentId],
      WINDOW_START,
    );
    expect(batchCalls).toBe(1);
    expect(statementCount).toBe(6);
  });
});

function d1WithBeforeFirstBatch(d1: D1Database, competing: () => Promise<unknown>): D1Database {
  let fired = false;
  return new Proxy(d1, {
    get(target, property, receiver) {
      if (property !== "batch") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (statements: unknown[]) => {
        if (!fired) {
          fired = true;
          await competing();
        }
        return target.batch(statements as never);
      };
    },
  }) as D1Database;
}

async function insertFlag(input: {
  id: string;
  key: string;
  lifecycleClass: string;
  createdAt: string;
}): Promise<void> {
  await local.d1
    .prepare(
      `INSERT INTO flags (
         id, app_id, key, name, lifecycle_class, created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user_seed', 'user_seed')`,
    )
    .bind(
      input.id,
      seed.a.appId,
      input.key,
      input.key,
      input.lifecycleClass,
      input.createdAt,
      input.createdAt,
    )
    .run();
  await local.d1
    .prepare(
      `INSERT INTO variants (id, flag_id, name, value, created_at)
       VALUES (?, ?, 'control', '"control"', ?)`,
    )
    .bind(`var_${input.id}`, input.id, input.createdAt)
    .run();
}
