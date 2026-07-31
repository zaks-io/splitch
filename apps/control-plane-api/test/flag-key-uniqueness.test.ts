import { appScope, createRepository, type Repository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  baseFlag,
  createDefaultApp,
  errorBody,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  NOW_ISO,
} from "../src/flag-definition-test-harness";
import { FLAG_LIST_READ_LIMIT } from "../src/overview-thresholds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * "Is this Flag key taken" is answered by a keyed lookup and backstopped by the
 * `(app_id, key)` unique index (SPL-234).
 *
 * The read this replaced scanned the App's whole Flag set, which is why it was
 * the one read in the bounded-read series that could NOT take a LIMIT: a row the
 * bound skipped reads back as a free key and permits a duplicate write. So the
 * App under test here holds MORE Flags than `FLAG_LIST_READ_LIMIT`, and the key
 * it collides on is the one a bounded page would have dropped.
 */
let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

/** The key of the OLDEST seeded Flag: last in `(created_at DESC, id DESC)`. */
const OLDEST_SEEDED_KEY = "bulk-flag-0000";

async function seedFlags(appId: string, count: number): Promise<void> {
  const repo = createRepository(h.bindings.d1);
  const scope = appScope(appId);
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(4, "0");
    await repo.flags.flags.insert(scope, {
      id: `flag_bulk_${suffix}`,
      appId,
      key: `bulk-flag-${suffix}`,
      name: `Bulk flag ${index}`,
      schema: JSON.stringify({ type: "boolean" }),
      defaultVariantId: `var_bulk_${suffix}`,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
  }
}

async function postFlag(appId: string, key: string, repo?: Repository): Promise<Response> {
  const app = repo ? makeAppForRepo(h, repo) : h.app;
  const body = { ...baseFlag(appId), key };
  return app.request(`/apps/${appId}/flags`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await appToken(h, appId)}`,
      "content-type": "application/json",
      "idempotency-key": body.idempotency_key,
    },
    body: JSON.stringify(body),
  });
}

/**
 * A pass-through D1 that records the SQL it is asked to prepare. The repository
 * is the seam under test, so the assertion has to be on what reached D1, not on
 * a spy over a method the repository calls internally through its own closure.
 */
function recordingD1(d1: D1Database, sink: string[]): D1Database {
  return new Proxy(d1, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => {
          sink.push(query);
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function flagIdsWithKey(appId: string, key: string): Promise<string[]> {
  const rows = await h.bindings.d1
    .prepare("SELECT id FROM flags WHERE app_id = ? AND key = ?")
    .bind(appId, key)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

async function expectKeyTaken(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  const body = await errorBody(res);
  expect(body.code).toBe("VALIDATION_ERROR");
  // A structured FIELD error, so the create form can attach it to the key input
  // rather than showing a generic failure.
  expect(body.details).toEqual({
    issues: [{ path: ["body", "key"], message: "flag key already exists in this App" }],
  });
}

describe("Flag key collision on an App larger than the catalog read bound", () => {
  it("refuses a key held by a Flag a bounded page would never have seen", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedFlags(appId, FLAG_LIST_READ_LIMIT + 1);

    const res = await postFlag(appId, OLDEST_SEEDED_KEY);

    await expectKeyTaken(res);
    // Ground truth, not just the wire status: the duplicate did not land.
    expect(await flagIdsWithKey(appId, OLDEST_SEEDED_KEY)).toEqual(["flag_bulk_0000"]);
  });

  it("answers the key check without materializing the Flag set", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedFlags(appId, FLAG_LIST_READ_LIMIT + 1);
    const statements: string[] = [];
    const repo = createRepository(recordingD1(h.bindings.d1, statements));

    const res = await postFlag(appId, "brand-new-key", repo);

    expect(res.status).toBe(200);
    // The wire response cannot see this: a scan and an index probe produce the
    // same 200 on an App of any size, only the cost differs. So the SQL actually
    // issued is asserted. Every read of `flags` on this path is keyed — none of
    // them selects the App's Flag set and filters in memory.
    const flagSelects = statements.filter((sql) => /^select .* from "flags"/.test(sql));
    expect(flagSelects.some((sql) => sql.includes('"flags"."key" = ?'))).toBe(true);
    // Every read of `flags` on this path is keyed on `key` or `id`. A read scoped
    // to the App alone is the scan this ticket removed, whether or not a LIMIT is
    // bolted onto it.
    expect(
      flagSelects.filter(
        (sql) => !(sql.includes('"flags"."key" = ?') || sql.includes('"flags"."id" = ?')),
      ),
    ).toEqual([]);
  });

  it("refuses a create that lost the race to a concurrent one, with the same field error", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    await seedFlags(appId, FLAG_LIST_READ_LIMIT + 1);
    const repo = createRepository(h.bindings.d1);
    // The TOCTOU window made deterministic: the pre-check sees a free key, and
    // the row is already there by the time the INSERT runs. Without the unique
    // index this request writes a duplicate and answers 200.
    const spied: Repository = {
      ...repo,
      flags: { ...repo.flags, getFlagByKey: async () => null },
    };

    const res = await postFlag(appId, OLDEST_SEEDED_KEY, spied);

    await expectKeyTaken(res);
    expect(await flagIdsWithKey(appId, OLDEST_SEEDED_KEY)).toEqual(["flag_bulk_0000"]);
  });
});
