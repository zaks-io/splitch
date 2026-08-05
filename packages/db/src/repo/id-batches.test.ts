import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { seedTwoTenants } from "./test-seed";

/**
 * D1 rejects a statement with more than 100 bound parameters, so every id-set
 * read has to survive an id set larger than that. Nothing about the failure is
 * gradual: under the cap it works, over it the query is a hard `D1_ERROR`, which
 * means only a test seeded PAST the cap covers it at all.
 */
let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: Awaited<ReturnType<typeof seedTwoTenants>>;
/**
 * Past `D1_ID_BATCH_SIZE` so batching is exercised, and past D1's own 100 cap so
 * an unbatched `inArray` genuinely fails. A count between the two would prove
 * nothing: 95 ids in one statement is still legal SQL.
 */
const BULK = 115;
const bulkIds = Array.from({ length: BULK }, (_, index) => `flag_batch_${index}`);

beforeAll(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
  const scope = appScope(seed.a.appId);
  for (const id of bulkIds) {
    await repo.flags.flags.insert(scope, {
      id,
      appId: seed.a.appId,
      key: id,
      name: id,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    await repo.flags.addVariant(scope, id, {
      id: `var_${id}`,
      name: "control",
      value: "false",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
  }
  // Two hundred-odd sequential local-D1 writes run well past vitest's 10s hook
  // default once the rest of the suite is competing for the machine.
}, 60_000);

afterAll(async () => {
  await local.dispose();
});

describe("id-set reads past D1's bound-parameter cap", () => {
  it("resolves every requested Flag rather than failing the statement", async () => {
    const rows = await repo.flags.listFlagsByIds(appScope(seed.a.appId), bulkIds);

    // Length is the assertion: a batch loop that drops its tail returns a short
    // list rather than an error, which is the silent version of this bug.
    expect(rows).toHaveLength(BULK);
  });

  it("resolves every requested Variant catalog, and still only this App's", async () => {
    const catalogs = await repo.flags.listVariantsForFlags(appScope(seed.a.appId), [
      ...bulkIds,
      seed.b.flagId,
    ]);

    expect(catalogs.size).toBe(BULK);
    // The scope proof runs per batch, so it has to survive batching too.
    expect(catalogs.has(seed.b.flagId)).toBe(false);
    expect(catalogs.get(bulkIds[BULK - 1] as string)).toHaveLength(1);
  });
});
