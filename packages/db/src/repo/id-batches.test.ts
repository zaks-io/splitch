import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import { twoAxisIdBatches } from "./id-batches";
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

  it("provisions a maximum-size Variant catalog without exceeding D1's binding cap", async () => {
    const scope = appScope(seed.a.appId);
    const values = Array.from({ length: 100 }, (_, index) => ({
      id: `var_create_batch_${index}`,
      name: `batched-${index}`,
      value: JSON.stringify(index),
      createdAt: "2026-07-01T00:00:00.000Z",
    }));

    const created = await repo.flags.ensureCreateVariants(scope, seed.a.flagId, values);
    const replayed = await repo.flags.ensureCreateVariants(scope, seed.a.flagId, values);

    expect(created).toHaveLength(100);
    expect(replayed.map((variant) => variant.id)).toEqual(created.map((variant) => variant.id));
  });

  it("selects the latest Run and isolates batched Run existence to one Environment", async () => {
    const scope = envScope(seed.a.appId, seed.a.environmentId);
    const first = await repo.experiments.getRun(scope, seed.a.runId);
    if (!first) throw new Error("seeded Run is missing");
    await repo.experiments.updateRunStatus(scope, first.id, {
      status: "ended",
      endedAt: "2026-07-01T12:00:00.000Z",
    });
    await repo.experiments.runs.insert(scope, {
      ...first,
      id: "run_a_latest",
      runNumber: 2,
      salt: "salt_run_a_latest",
      startedAt: "2026-07-02T00:00:00.000Z",
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    const latest = await repo.experiments.findLatestRunForExperiment(scope, seed.a.experimentId);
    const withRuns = await repo.experiments.listExperimentIdsWithRuns(scope, [
      seed.a.experimentId,
      seed.b.experimentId,
    ]);

    expect(latest?.id).toBe("run_a_latest");
    expect(withRuns).toEqual([seed.a.experimentId]);
  });
});

describe("two-axis id batches", () => {
  it("covers both axes while keeping each statement at 90 IN bindings", () => {
    const first = Array.from({ length: 115 }, (_, index) => `flag_${index}`);
    const second = Array.from({ length: 52 }, (_, index) => `env_${index}`);
    const batches = twoAxisIdBatches(first, second);

    expect(batches.every((batch) => batch.first.length + batch.second.length <= 90)).toBe(true);
    const pairs = new Set(
      batches.flatMap((batch) =>
        batch.first.flatMap((flagId) =>
          batch.second.map((environmentId) => `${flagId}:${environmentId}`),
        ),
      ),
    );
    expect(pairs.size).toBe(first.length * second.length);
  });
});
