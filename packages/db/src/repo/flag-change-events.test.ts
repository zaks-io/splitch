import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import {
  changes,
  insertConfig,
  insertSecondEnvironment,
  toggleConfig,
} from "./test-flag-change-fixtures";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * The read side of the flag-change log: cursor semantics, Environment scoping,
 * and retention. The triggers that produce these rows are proved separately in
 * `flag-change-triggers.test.ts`.
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

describe("flagChangeEvents repo", () => {
  it("returns App-level changes alongside the requested Environment's own", async () => {
    await insertSecondEnvironment(local.d1, seed);
    await insertConfig(local.d1, seed);
    await insertConfig(local.d1, seed, { id: "cfg_a2", environmentId: "env_a_two" });
    await toggleConfig(local.d1, seed);
    await toggleConfig(local.d1, seed, "env_a_two");

    const pending = await repo.flagChangeEvents.pendingForScope(
      seed.a.appId,
      seed.a.environmentId,
      0,
      100,
    );

    // App-level DEFINITION changes carry environment_id NULL and affect every
    // Environment, so an Environment-scoped consumer must still receive them.
    expect(pending.some((row) => row.environmentId === null)).toBe(true);
    expect(pending.some((row) => row.environmentId === seed.a.environmentId)).toBe(true);
    expect(pending.some((row) => row.environmentId === "env_a_two")).toBe(false);
  });

  it("never returns another tenant's changes", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const pending = await repo.flagChangeEvents.pendingForScope(
      seed.b.appId,
      seed.b.environmentId,
      0,
      100,
    );
    expect(pending.every((row) => row.appId === seed.b.appId)).toBe(true);
    expect(pending.some((row) => row.flagKey === seed.a.flagKey)).toBe(false);
  });

  it("resumes strictly after the cursor and honours the batch limit", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const all = await repo.flagChangeEvents.pendingForScope(
      seed.a.appId,
      seed.a.environmentId,
      0,
      100,
    );
    expect(all.length).toBeGreaterThan(2);

    const cursor = all[0]?.seq ?? 0;
    const resumed = await repo.flagChangeEvents.pendingForScope(
      seed.a.appId,
      seed.a.environmentId,
      cursor,
      1,
    );
    // Strictly after: redelivering the row at the cursor would double-report a
    // change the consumer has already acknowledged.
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.seq).toBe(all[1]?.seq);
  });

  it("prunes only history that is both aged out and behind every cursor", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const all = await changes(local.d1, seed.a.appId);
    const keepFrom = all[1]?.seq ?? 0;

    const pruned = await repo.flagChangeEvents.pruneBefore({
      changedBefore: "2099-01-01T00:00:00.000Z",
      minUndeliveredSeq: keepFrom,
      limit: 100,
    });

    expect(pruned).toBe(1);
    // An integration still sitting on `keepFrom` must not have its backlog
    // deleted out from under it, however old those rows are.
    const remaining = await changes(local.d1, seed.a.appId);
    expect(remaining[0]?.seq).toBe(keepFrom);
  });

  it("keeps history that is behind every cursor but not yet aged out", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const pruned = await repo.flagChangeEvents.pruneBefore({
      changedBefore: "2000-01-01T00:00:00.000Z",
      minUndeliveredSeq: Number.MAX_SAFE_INTEGER,
      limit: 100,
    });
    expect(pruned).toBe(0);
  });
});
