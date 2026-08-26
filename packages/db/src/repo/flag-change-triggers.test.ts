import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import {
  changes,
  insertConfig,
  insertRule,
  insertRun,
  FLAG_CHANGE_NOW as NOW,
  toggleConfig,
} from "./test-flag-change-fixtures";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * The flag-change log is written by D1 TRIGGERS, so the proof has to go through
 * real SQL against the real emitted schema. A repo-level fake would assert
 * nothing about whether the trigger exists or fires on the right table.
 *
 * These tests are the mutation target for 0026_flag_change_log.sql: dropping any
 * trigger, or repointing one at another tenant, must fail at least one of them.
 */

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("flag_change_events triggers: Flag definition and configuration", () => {
  it("records a flag definition create with its actor and no environment", async () => {
    const before = await changes(local.d1, seed.a.appId);
    await local.d1
      .prepare(
        `INSERT INTO flags (id, app_id, key, name, created_at, updated_at, created_by, updated_by)
         VALUES ('flag_new', ?, 'new-flag', 'New Flag', ?, ?, 'user_alice', 'user_alice')`,
      )
      .bind(seed.a.appId, NOW, NOW)
      .run();

    const added = (await changes(local.d1, seed.a.appId)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      appId: seed.a.appId,
      flagKey: "new-flag",
      action: "created",
      targetType: "flag",
      actorRef: "user_alice",
      // App-level DEFINITION has no Environment axis (ADR-0027).
      environmentId: null,
    });
  });

  it("records a flag definition rename attributed to its updater", async () => {
    const before = await changes(local.d1, seed.a.appId);
    await local.d1
      .prepare(
        "UPDATE flags SET name = 'Renamed', updated_at = ?, updated_by = 'user_bob' WHERE id = ?",
      )
      .bind(NOW, seed.a.flagId)
      .run();

    const added = (await changes(local.d1, seed.a.appId)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      appId: seed.a.appId,
      flagKey: seed.a.flagKey,
      action: "updated",
      targetType: "flag",
      actorRef: "user_bob",
      environmentId: null,
    });
    expect(JSON.parse(added[0]?.diffJson ?? "{}").name).toEqual(["A Flag", "Renamed"]);
  });

  it("survives deletion of the flag it audits", async () => {
    await local.d1
      .prepare(
        `INSERT INTO flags (id, app_id, key, name, created_at, updated_at, created_by, updated_by)
         VALUES ('flag_doomed', ?, 'doomed', 'Doomed', ?, ?, 'user_alice', 'user_alice')`,
      )
      .bind(seed.a.appId, NOW, NOW)
      .run();
    // An audit row carrying a foreign key to its subject would abort this delete.
    await local.d1.prepare("DELETE FROM flags WHERE id = 'flag_doomed'").run();

    const doomed = (await changes(local.d1, seed.a.appId)).filter(
      (row) => row.flagKey === "doomed",
    );
    expect(doomed.map((row) => row.action)).toEqual(["created", "deleted"]);
  });

  it("records a config toggle as an update attributed to updated_by", async () => {
    const before = await changes(local.d1, seed.a.appId);
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);

    const added = (await changes(local.d1, seed.a.appId)).slice(before.length);
    const toggle = added.at(-1);
    expect(toggle).toMatchObject({
      appId: seed.a.appId,
      flagKey: seed.a.flagKey,
      action: "updated",
      targetType: "flag_config",
      actorRef: "user_bob",
      environmentId: seed.a.environmentId,
    });
    // The diff must show the transition, not just the landing value: "enabled is
    // true" is not the same fact as "someone turned it on".
    expect(JSON.parse(toggle?.diffJson ?? "{}").enabled).toEqual([0, 1]);
  });

  it("records a config delete as the Flag leaving that Environment", async () => {
    await insertConfig(local.d1, seed);
    const before = await changes(local.d1, seed.a.appId);
    await local.d1.prepare("DELETE FROM flag_configs WHERE id = 'cfg_a'").run();

    const added = (await changes(local.d1, seed.a.appId)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      appId: seed.a.appId,
      flagKey: seed.a.flagKey,
      action: "deleted",
      targetType: "flag_config",
      environmentId: seed.a.environmentId,
    });
  });
});

describe("flag_change_events triggers: Variants, targeting rules, and Runs", () => {
  it("attributes a variant addition to the owning flag key", async () => {
    const before = await changes(local.d1, seed.a.appId);
    await local.d1
      .prepare(
        `INSERT INTO variants (id, flag_id, name, value, created_at)
         VALUES ('var_new', ?, 'treatment', '"on"', ?)`,
      )
      .bind(seed.a.flagId, NOW)
      .run();

    const added = (await changes(local.d1, seed.a.appId)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      appId: seed.a.appId,
      flagKey: seed.a.flagKey,
      action: "updated",
      targetType: "variant",
      environmentId: null,
    });
  });

  it("records a variant value change against the owning flag", async () => {
    const before = await changes(local.d1, seed.a.appId);
    await local.d1
      .prepare(`UPDATE variants SET value = '"changed"' WHERE id = ?`)
      .bind(seed.a.variantId)
      .run();

    const added = (await changes(local.d1, seed.a.appId)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      appId: seed.a.appId,
      flagKey: seed.a.flagKey,
      action: "updated",
      targetType: "variant",
      environmentId: null,
    });
    expect(JSON.parse(added[0]?.diffJson ?? "{}").value).toEqual(['"control"', '"changed"']);
  });

  it("records a variant removal against the owning flag", async () => {
    const before = await changes(local.d1, seed.a.appId);
    await local.d1.prepare("DELETE FROM variants WHERE id = ?").bind(seed.a.variantId).run();

    const added = (await changes(local.d1, seed.a.appId)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      appId: seed.a.appId,
      flagKey: seed.a.flagKey,
      action: "updated",
      targetType: "variant",
      environmentId: null,
    });
    expect(JSON.parse(added[0]?.diffJson ?? "{}")).toMatchObject({
      variant: "control",
      change: "removed",
    });
  });

  it("records the whole targeting-rule lifecycle against the flag's Environment", async () => {
    const before = await changes(local.d1, seed.a.appId);
    await insertRule(local.d1, seed);
    await local.d1
      .prepare("UPDATE targeting_rules SET priority = 2, updated_at = ? WHERE id = 'rule_a'")
      .bind(NOW)
      .run();
    await local.d1.prepare("DELETE FROM targeting_rules WHERE id = 'rule_a'").run();

    const added = (await changes(local.d1, seed.a.appId)).slice(before.length);
    expect(added).toHaveLength(3);
    for (const row of added) {
      expect(row).toMatchObject({
        appId: seed.a.appId,
        flagKey: seed.a.flagKey,
        // Adding, reordering, and removing a rule all change what the Flag
        // serves; none of them creates or deletes the Flag itself.
        action: "updated",
        targetType: "targeting_rule",
        environmentId: seed.a.environmentId,
      });
    }
    expect(added.map((row) => JSON.parse(row.diffJson ?? "{}").change)).toEqual([
      "added",
      undefined,
      "removed",
    ]);
  });

  it("records starting and ending a Run as a change to the Run's flag", async () => {
    const before = await changes(local.d1, seed.a.appId);
    await insertRun(local.d1, seed);
    await local.d1
      .prepare("UPDATE runs SET status = 'ended', end_reason = 'shipped' WHERE id = 'run_a_two'")
      .run();

    const added = (await changes(local.d1, seed.a.appId)).slice(before.length);
    expect(added).toHaveLength(2);
    for (const row of added) {
      expect(row).toMatchObject({
        appId: seed.a.appId,
        flagKey: seed.a.flagKey,
        action: "updated",
        targetType: "run",
        actorRef: "user_carol",
        environmentId: seed.a.environmentId,
      });
    }
    expect(JSON.parse(added[1]?.diffJson ?? "{}").status).toEqual(["running", "ended"]);
  });
});

describe("flag_change_events triggers: log-wide invariants", () => {
  it("emits ISO 8601 UTC timestamps, not SQLite's space-separated form", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const rows = await changes(local.d1, seed.a.appId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("assigns monotonically increasing seq values usable as an idempotency token", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const seqs = (await changes(local.d1, seed.a.appId)).map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("never attributes one tenant's change to another", async () => {
    await insertConfig(local.d1, seed);
    await toggleConfig(local.d1, seed);
    const other = await changes(local.d1, seed.b.appId);
    expect(other.every((row) => row.appId === seed.b.appId)).toBe(true);
    expect(other.some((row) => row.flagKey === seed.a.flagKey)).toBe(false);
  });
});
