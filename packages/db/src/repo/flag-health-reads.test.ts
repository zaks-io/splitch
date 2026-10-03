import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * Inventory health must read class, age, churn, and expired counts in one D1
 * batch (consistent snapshot). Stale unchanged detection must load latest
 * change-log instants only for the live page's flagIds — not every historical
 * Flag left behind when pruning stalls.
 */

const AS_OF = "2026-07-02T12:00:00.000Z";
const NOW = "2026-06-28T00:00:00.000Z";

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("flagHealth.loadInventoryHealthAggregates", () => {
  it("returns exactly five age-bucket rows and no per-Flag createdAt materialization", async () => {
    const repo = createRepository(local.d1);
    await insertFlag({
      id: "flag_age_old",
      key: "age-old",
      lifecycleClass: "release",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    await local.d1
      .prepare(`UPDATE flags SET created_at = ? WHERE id = ?`)
      .bind("2026-05-15T00:00:00.000Z", seed.a.flagId)
      .run();

    const aggregates = await repo.flagHealth.loadInventoryHealthAggregates(
      appScope(seed.a.appId),
      AS_OF,
    );

    expect(aggregates.ageBuckets).toEqual([
      { bucket: "0_30d", count: 0 },
      { bucket: "30_90d", count: 1 },
      { bucket: "90_180d", count: 0 },
      { bucket: "180_365d", count: 0 },
      { bucket: "365d_plus", count: 1 },
    ]);
    expect(aggregates.ageBuckets).toHaveLength(5);
    const classTotal = aggregates.classRows.reduce((sum, row) => sum + row.count, 0);
    const ageTotal = aggregates.ageBuckets.reduce((sum, row) => sum + row.count, 0);
    expect(ageTotal).toBe(classTotal);
  });

  it("keeps earliestChangeLogAt and creation months consistent on first concurrent create", async () => {
    const emptyAppId = await insertEmptyApp("first_create");
    const firstCreateAt = "2026-07-02T11:59:59.000Z";
    let injected = false;
    const racingD1 = d1WithBeforeFirstBatch(local.d1, async () => {
      if (injected) return;
      injected = true;
      await local.d1
        .prepare(
          `INSERT INTO flags (
             id, app_id, key, name, lifecycle_class, created_at, updated_at, created_by, updated_by
           ) VALUES (?, ?, ?, ?, 'release', ?, ?, 'user_race', 'user_race')`,
        )
        .bind(
          "flag_first",
          emptyAppId,
          "first-create",
          "first-create",
          firstCreateAt,
          firstCreateAt,
        )
        .run();
    });

    const aggregates = await createRepository(racingD1).flagHealth.loadInventoryHealthAggregates(
      appScope(emptyAppId),
      AS_OF,
    );

    expect(injected).toBe(true);
    expect(aggregates.creationMonths).toEqual(
      expect.arrayContaining([expect.objectContaining({ count: 1 })]),
    );
    expect(aggregates.earliestLog).not.toBeNull();
  });

  it("keeps class totals and age totals agreed across a concurrent delete", async () => {
    await insertFlag({
      id: "flag_doomed",
      key: "doomed",
      lifecycleClass: "permission",
      createdAt: NOW,
    });
    let deleted = false;
    const racingD1 = d1WithBeforeFirstBatch(local.d1, async () => {
      if (deleted) return;
      deleted = true;
      await local.d1.prepare(`DELETE FROM variants WHERE flag_id = ?`).bind("flag_doomed").run();
      await local.d1.prepare(`DELETE FROM flags WHERE id = ?`).bind("flag_doomed").run();
    });

    const aggregates = await createRepository(racingD1).flagHealth.loadInventoryHealthAggregates(
      appScope(seed.a.appId),
      AS_OF,
    );

    expect(deleted).toBe(true);
    const classTotal = aggregates.classRows.reduce((sum, row) => sum + row.count, 0);
    const ageTotal = aggregates.ageBuckets.reduce((sum, row) => sum + row.count, 0);
    expect(ageTotal).toBe(classTotal);
    expect(classTotal).toBe(1);
  });

  it("loads inventory aggregates through a single D1 batch", async () => {
    let batchCalls = 0;
    const countingD1 = new Proxy(local.d1, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: unknown[]) => {
            batchCalls += 1;
            expect(statements).toHaveLength(6);
            return Reflect.apply(target.batch, target, [statements]);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    await createRepository(countingD1).flagHealth.loadInventoryHealthAggregates(
      appScope(seed.a.appId),
      AS_OF,
    );
    expect(batchCalls).toBe(1);
  });
});

describe("flagHealth.latestChangeAtByFlagId", () => {
  it("excludes unrelated historical Flags outside the selected page", async () => {
    const historicalId = "flag_historical_deleted";
    await insertFlag({
      id: historicalId,
      key: "historical",
      lifecycleClass: "release",
      createdAt: "2025-06-01T00:00:00.000Z",
    });
    await local.d1
      .prepare(`UPDATE flag_change_events SET changed_at = ? WHERE app_id = ? AND flag_id = ?`)
      .bind("2025-06-01T00:00:00.000Z", seed.a.appId, historicalId)
      .run();
    await local.d1.prepare(`DELETE FROM variants WHERE flag_id = ?`).bind(historicalId).run();
    await local.d1.prepare(`DELETE FROM flags WHERE id = ?`).bind(historicalId).run();

    await local.d1
      .prepare(
        `UPDATE flags SET name = 'Touched', updated_at = ?, updated_by = 'user_live' WHERE id = ?`,
      )
      .bind(AS_OF, seed.a.flagId)
      .run();

    const latest = await createRepository(local.d1).flagHealth.latestChangeAtByFlagId(
      appScope(seed.a.appId),
      [seed.a.flagId],
    );

    expect(latest.has(seed.a.flagId)).toBe(true);
    expect(latest.has(historicalId)).toBe(false);
    expect([...latest.keys()]).toEqual([seed.a.flagId]);
  });

  it("returns an empty map without scanning when the page is empty", async () => {
    let batchOrPrepareHits = 0;
    const watching = new Proxy(local.d1, {
      get(target, property, receiver) {
        if (property === "prepare" || property === "batch") {
          return (...args: unknown[]) => {
            batchOrPrepareHits += 1;
            const value = Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown;
            return value.apply(target, args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const latest = await createRepository(watching).flagHealth.latestChangeAtByFlagId(
      appScope(seed.a.appId),
      [],
    );
    expect(latest.size).toBe(0);
    expect(batchOrPrepareHits).toBe(0);
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

async function insertEmptyApp(suffix: string): Promise<string> {
  const orgId = `org_${suffix}`;
  const appId = `app_${suffix}`;
  await local.d1
    .prepare(
      `INSERT INTO organizations (id, name, slug, plan, created_at, updated_at)
       VALUES (?, ?, ?, 'free', ?, ?)`,
    )
    .bind(orgId, orgId, orgId, NOW, NOW)
    .run();
  await local.d1
    .prepare(
      `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(appId, orgId, appId, appId, NOW, NOW)
    .run();
  return appId;
}

async function insertFlag(input: {
  id: string;
  key: string;
  lifecycleClass: string;
  createdAt: string;
  createdBy?: string;
}): Promise<void> {
  await local.d1
    .prepare(
      `INSERT INTO flags (
         id, app_id, key, name, lifecycle_class, created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      seed.a.appId,
      input.key,
      input.key,
      input.lifecycleClass,
      input.createdAt,
      input.createdAt,
      input.createdBy ?? "user_seed",
      input.createdBy ?? "user_seed",
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
