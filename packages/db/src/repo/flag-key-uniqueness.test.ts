import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
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

  it("classifies an idempotency collision separately from a Flag-key collision", async () => {
    const scope = appScope(seed.a.appId);
    const first = {
      ...flagValues(seed.a.appId, "flag_idempotency_winner", "first-idempotent-key"),
      createdBy: "user_create_actor",
      createIdempotencyKey: "idem_flag_repo_collision",
    };
    const second = {
      ...flagValues(seed.a.appId, "flag_idempotency_loser", "second-idempotent-key"),
      createdBy: first.createdBy,
      createIdempotencyKey: first.createIdempotencyKey,
    };

    expect((await repo.flags.createFlag(scope, first)).ok).toBe(true);
    expect(await repo.flags.createFlag(scope, second)).toEqual({
      ok: false,
      reason: "idempotency_conflict",
    });
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

  // The classifier has to read text, because D1 puts the extended result code
  // only in prose. That makes WHICH text it reads a security property: the query
  // error Drizzle throws stringifies the caller's own values into its message, so
  // a Flag field carrying the constraint string is an attempt to forge a
  // collision out of an unrelated failure — and be told "pick another key" for a
  // key that was free while a real fault disappears.
  for (const field of ["key", "name", "description"] as const) {
    it(`does not let a poisoned Flag ${field} forge a key collision`, async () => {
      const values = flagValues(seed.a.appId, "flag_poisoned", "never-used-key") as Record<
        string,
        unknown
      >;
      values[field] = POISON;
      const failing = createRepository(failingInsertD1(local.d1, TRANSIENT_D1_FAILURE));

      const outcome = await failing.flags
        .createFlag(
          appScope(seed.a.appId),
          values as unknown as Parameters<typeof repo.flags.createFlag>[1],
        )
        .then(
          (result) => result as unknown,
          (error: unknown) => error,
        );

      // The transient fault must still be a fault. Classifying it as a collision
      // would answer a write that never happened with "pick another key".
      expect(outcome).toBeInstanceOf(Error);
      // And the vector is live, not hypothetical: the poisoned value really does
      // reach the message the naive walk would have read.
      expect((outcome as Error).message).toContain(POISON);
      expect(await rawFlagIds(local, seed.a.appId, "never-used-key")).toEqual([]);
    });
  }

  it("does not classify a D1 failure that only quotes the constraint text", async () => {
    // Both tokens are required in D1's OWN message. The column list says WHICH
    // uniqueness could have failed; the extended result code says a uniqueness
    // check is what failed at all. A failure that merely mentions the constraint
    // is not a collision, and answering it with "pick another key" would send an
    // operator after a key that was never taken.
    const failing = createRepository(
      failingInsertD1(
        local.d1,
        "D1_ERROR: could not apply statement (UNIQUE constraint failed: flags.app_id, flags.key)",
      ),
    );

    await expect(
      failing.flags.createFlag(
        appScope(seed.a.appId),
        flagValues(seed.a.appId, "flag_quoting_failure", "never-used-key"),
      ),
    ).rejects.toThrow();
    expect(await rawFlagIds(local, seed.a.appId, "never-used-key")).toEqual([]);
  });

  it("does not classify D1's parameter-free bind-time echo of the collision text", async () => {
    // The parameter skip alone is NOT enough. D1 rejects an unsupported value at
    // bind time with a message that carries no `params` of its own yet quotes the
    // caller's value verbatim, so it survives the skip:
    //
    //   D1_TYPE_ERROR: Type 'object' not supported for value '<caller's value>'
    //
    // A caller who spells the whole collision string, extended result code and
    // all, therefore reaches a layer the skip yields. Substring matching would
    // call this a collision and tell the operator to pick a different key while
    // the key was free and nothing was written. Anchoring is what refuses it.
    const failing = createRepository(
      failingInsertD1(local.d1, `D1_TYPE_ERROR: Type 'object' not supported for value '${POISON}'`),
    );

    await expect(
      failing.flags.createFlag(
        appScope(seed.a.appId),
        flagValues(seed.a.appId, "flag_bind_time_echo", "never-used-key"),
      ),
    ).rejects.toThrow();
    expect(await rawFlagIds(local, seed.a.appId, "never-used-key")).toEqual([]);
  });
});

const TRANSIENT_D1_FAILURE = "D1_ERROR: Network connection lost.";

/** Exactly what D1 says on a real collision, authored by the caller instead. */
const POISON =
  "UNIQUE constraint failed: flags.app_id, flags.key: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)";

/**
 * A D1 whose Flag INSERT fails with a transient fault. Every other statement
 * passes through, so the poisoned values still travel as bound parameters into
 * the query error Drizzle raises — which is the vector under test.
 */
function failingInsertD1(d1: D1Database, message: string): D1Database {
  return new Proxy(d1, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!/^insert into "flags"/.test(query)) return statement;
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
