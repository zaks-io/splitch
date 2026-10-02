import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import {
  changes,
  insertConfig,
  insertSecondEnvironment,
  toggleConfig,
} from "./test-flag-change-fixtures";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * The read side of the flag-change log: cursor semantics, Organization scoping,
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
  it("returns every Environment's changes under the Organization", async () => {
    await insertSecondEnvironment(local.d1, seed);
    await insertConfig(local.d1, seed);
    await insertConfig(local.d1, seed, { id: "cfg_a2", environmentId: "env_a_two" });
    await toggleConfig(local.d1, seed);
    await toggleConfig(local.d1, seed, "env_a_two");

    const pending = await repo.flagChangeEvents.pendingForOrg(seed.a.orgId, 0, 100);

    // Sentry's flag log has no environment axis, so a per-Environment filter
    // here would silently drop real production changes. App-level DEFINITION
    // changes carry environment_id NULL and belong in the same stream.
    expect(pending.some((row) => row.environmentId === null)).toBe(true);
    expect(pending.some((row) => row.environmentId === seed.a.environmentId)).toBe(true);
    expect(pending.some((row) => row.environmentId === "env_a_two")).toBe(true);
  });

  it("never returns another tenant's changes", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const pending = await repo.flagChangeEvents.pendingForOrg(seed.b.orgId, 0, 100);
    expect(pending.every((row) => row.appId === seed.b.appId)).toBe(true);
    expect(pending.some((row) => row.flagKey === seed.a.flagKey)).toBe(false);
  });

  it("resumes strictly after the cursor and honours the batch limit", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const all = await repo.flagChangeEvents.pendingForOrg(seed.a.orgId, 0, 100);
    expect(all.length).toBeGreaterThan(2);

    const cursor = all[0]?.seq ?? 0;
    const resumed = await repo.flagChangeEvents.pendingForOrg(seed.a.orgId, cursor, 1);
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

  it("lists an App's stored rows under a minted TenantScope and never another tenant", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const page = await repo.flagChangeEvents.listForApp(appScope(seed.a.appId), {
      includeAppLevel: true,
      order: "asc",
      limit: 100,
    });
    expect(page.some((row) => row.diffJson !== null && row.appId === seed.a.appId)).toBe(true);
    expect(page.every((row) => row.appId === seed.a.appId)).toBe(true);

    const foreign = await repo.flagChangeEvents.listForApp(appScope(seed.b.appId), {
      includeAppLevel: true,
      order: "asc",
      limit: 100,
    });
    expect(foreign.some((row) => row.appId === seed.a.appId)).toBe(false);
  });

  it("filters a promotion pair to those Environments plus App-level rows", async () => {
    await insertSecondEnvironment(local.d1, seed);
    await insertConfig(local.d1, seed);
    await insertConfig(local.d1, seed, { id: "cfg_a2", environmentId: "env_a_two" });
    await toggleConfig(local.d1, seed);
    const page = await repo.flagChangeEvents.listForApp(appScope(seed.a.appId), {
      environmentIds: [seed.a.environmentId, "env_a_two"],
      includeAppLevel: true,
      order: "asc",
      limit: 100,
    });
    expect(page.some((row) => row.environmentId === seed.a.environmentId)).toBe(true);
    expect(page.some((row) => row.environmentId === null)).toBe(true);
  });

  it("includes a stored UTC boundary when the lower bound omits milliseconds", async () => {
    await insertChangeAt(local.d1, seed, "2026-08-25T00:00:00.000Z");
    const page = await repo.flagChangeEvents.listForApp(appScope(seed.a.appId), {
      from: "2026-08-25T00:00:00Z",
      to: "2026-08-25T00:00:00Z",
      includeAppLevel: true,
      order: "asc",
      limit: 100,
    });
    expect(page).toHaveLength(1);
    expect(page[0]?.changedAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("applies offset bounds as UTC instants rather than string prefixes", async () => {
    await insertChangeAt(local.d1, seed, "2026-08-25T01:00:00.000Z");
    await insertChangeAt(local.d1, seed, "2026-08-25T03:00:00.000Z");

    // from = 2026-08-25T02:00:00Z via -02:00 offset. The 01:00Z row is out of
    // range by instant but would survive a naive string compare against the
    // offset form.
    const page = await repo.flagChangeEvents.listForApp(appScope(seed.a.appId), {
      from: "2026-08-25T00:00:00-02:00",
      to: "2026-08-25T04:00:00Z",
      includeAppLevel: true,
      order: "asc",
      limit: 100,
    });
    expect(page.map((row) => row.changedAt)).toEqual(["2026-08-25T03:00:00.000Z"]);
  });
});

async function insertChangeAt(
  d1: D1Database,
  seed: SeededTenants,
  changedAt: string,
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO flag_change_events
        (app_id, environment_id, flag_id, flag_key, action, target_type,
         actor_ref, actor_via, changed_at, diff_json)
       VALUES (?, NULL, ?, ?, 'updated', 'flag', NULL, NULL, ?, '{"key":["a","b"]}')`,
    )
    .bind(seed.a.appId, seed.a.flagId, seed.a.flagKey, changedAt)
    .run();
}
