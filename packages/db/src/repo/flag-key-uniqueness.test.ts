import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * Flag key uniqueness is a DATABASE fact (`flags_app_key_unique`), not a
 * convention a caller upholds by remembering to look first (SPL-234).
 *
 * These tests go straight at `createFlag`, skipping any pre-check, because that
 * is exactly the shape of the two failures that matter: a caller that never read
 * first, and a caller whose read raced a concurrent create. Both must end in a
 * refused write.
 */

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

const NOW = "2026-07-30T00:00:00.000Z";

function flagValues(appId: string, id: string, key: string) {
  return {
    id,
    appId,
    key,
    name: "Second Flag",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function rawFlagIds(local: LocalD1, appId: string, key: string): Promise<string[]> {
  const rows = await local.d1
    .prepare("SELECT id FROM flags WHERE app_id = ? AND key = ?")
    .bind(appId, key)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

describe("Flag key uniqueness is enforced by the database", () => {
  it("refuses a second Flag with the same key in the same App", async () => {
    const conflict = await repo.flags.createFlag(
      appScope(seed.a.appId),
      flagValues(seed.a.appId, "flag_dupe_attempt", seed.a.flagKey),
    );

    expect(conflict).toEqual({ ok: false, reason: "key_conflict" });
    // The refusal is the whole point: a returned error with the row written
    // anyway would be worse than a throw.
    expect(await rawFlagIds(local, seed.a.appId, seed.a.flagKey)).toEqual([seed.a.flagId]);
  });

  it("lets a different App hold the same key", async () => {
    // The index is scoped to the App (ADR-0018). A global key namespace would
    // leak one Organization's naming into another's and refuse a legitimate write.
    const created = await repo.flags.createFlag(
      appScope(seed.b.appId),
      flagValues(seed.b.appId, "flag_same_key_other_app", seed.a.flagKey),
    );

    expect(created.ok).toBe(true);
    expect(await rawFlagIds(local, seed.b.appId, seed.a.flagKey)).toEqual([
      "flag_same_key_other_app",
    ]);
  });

  it("refuses exactly one of two concurrent creates of the same key", async () => {
    // The check-then-write race with the check removed entirely. One winner, one
    // `key_conflict`, one row.
    const scope = appScope(seed.a.appId);
    const results = await Promise.all([
      repo.flags.createFlag(scope, flagValues(seed.a.appId, "flag_race_one", "raced-key")),
      repo.flags.createFlag(scope, flagValues(seed.a.appId, "flag_race_two", "raced-key")),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "key_conflict" }]);
    expect(await rawFlagIds(local, seed.a.appId, "raced-key")).toHaveLength(1);
  });

  it("still throws on a write failure that is not a key collision", async () => {
    // `key_conflict` is a narrow classification, not a catch-all. A NOT NULL
    // violation names the same column and must NOT be reported as "pick another
    // key" — advice that could never succeed.
    const values = flagValues(seed.a.appId, "flag_null_name", "null-name-key") as unknown as Record<
      string,
      unknown
    >;
    values.name = null;

    await expect(
      repo.flags.createFlag(
        appScope(seed.a.appId),
        values as unknown as Parameters<typeof repo.flags.createFlag>[1],
      ),
    ).rejects.toThrow();
  });
});
