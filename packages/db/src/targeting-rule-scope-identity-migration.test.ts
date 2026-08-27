import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { applySchema, migrationFileStatements, migrationStatementsThrough } from "./repo/test-d1";

let mf: Miniflare | undefined;

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

const NOW = "2026-08-26T00:00:00.000Z";
const MIGRATION = "0027_targeting_rule_scope_identity.sql";

describe("Targeting Rule scope identity migration", () => {
  it("preserves every existing row and then allows the same id on another Flag", async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default {};",
      d1Databases: { DB: ":memory:" },
    });
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applySchema(d1, migrationStatementsThrough("0026_flag_change_log.sql"));
    await seedLegacyRules(d1);

    const before = await ruleRows(d1);
    expect(before).toEqual([
      legacyRule("rule_checkout", "flag_checkout"),
      legacyRule("rule_search", "flag_search"),
    ]);

    await applySchema(d1, migrationFileStatements(MIGRATION));

    expect(await ruleRows(d1)).toEqual(before);
    expect(await uniqueIndexSql(d1)).toContain(
      "ON `targeting_rules` (`app_id`,`environment_id`,`flag_id`,`id`)",
    );
    expect(await idPrimaryKey(d1)).toBe(false);
    expect(await triggerNames(d1)).toEqual([
      "convex_targeting_rule_version_after_delete",
      "convex_targeting_rule_version_after_insert",
      "convex_targeting_rule_version_after_update",
      "flag_change_rule_after_delete",
      "flag_change_rule_after_insert",
      "flag_change_rule_after_update",
    ]);

    await d1
      .prepare(
        "INSERT INTO targeting_rules (id, app_id, environment_id, flag_id, priority, conditions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("rule_checkout", "app_one", "env_one", "flag_search", 1, "[]", NOW, NOW)
      .run();

    expect(await ruleIds(d1)).toEqual([
      ["rule_checkout", "flag_checkout"],
      ["rule_checkout", "flag_search"],
      ["rule_search", "flag_search"],
    ]);
  });
});

async function seedLegacyRules(d1: D1Database): Promise<void> {
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("org_one", "Org", "org-one", "free", NOW, NOW),
    d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("app_one", "org_one", "App", "app-one", NOW, NOW),
    d1
      .prepare(
        "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("env_one", "app_one", "prod", "Production", NOW, NOW),
    d1
      .prepare(
        "INSERT INTO flags (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("flag_checkout", "app_one", "checkout", "Checkout", NOW, NOW),
    d1
      .prepare(
        "INSERT INTO flags (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("flag_search", "app_one", "search", "Search", NOW, NOW),
    d1
      .prepare(
        "INSERT INTO targeting_rules (id, app_id, environment_id, flag_id, priority, conditions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("rule_checkout", "app_one", "env_one", "flag_checkout", 0, "[]", NOW, NOW),
    d1
      .prepare(
        "INSERT INTO targeting_rules (id, app_id, environment_id, flag_id, priority, conditions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("rule_search", "app_one", "env_one", "flag_search", 0, "[]", NOW, NOW),
  ]);
}

function legacyRule(id: string, flagId: string) {
  return {
    id,
    app_id: "app_one",
    environment_id: "env_one",
    flag_id: flagId,
    priority: 0,
    conditions: "[]",
    segment_id: null,
    variant_id: null,
    percentage_rollout: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function ruleRows(d1: D1Database) {
  const rows = await d1
    .prepare("SELECT * FROM targeting_rules ORDER BY id, flag_id")
    .all<ReturnType<typeof legacyRule>>();
  return rows.results;
}

async function ruleIds(d1: D1Database) {
  const rows = await d1
    .prepare("SELECT id, flag_id FROM targeting_rules ORDER BY id, flag_id")
    .all<{ id: string; flag_id: string }>();
  return rows.results.map((row) => [row.id, row.flag_id]);
}

async function uniqueIndexSql(d1: D1Database): Promise<string> {
  const rows = await d1
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .bind("targeting_rules_scope_id_unique")
    .all<{ sql: string }>();
  return rows.results[0]?.sql ?? "";
}

async function idPrimaryKey(d1: D1Database): Promise<boolean> {
  const columns = await d1
    .prepare("PRAGMA table_info('targeting_rules')")
    .all<{ name: string; pk: number }>();
  return columns.results.some((column) => column.name === "id" && column.pk > 0);
}

async function triggerNames(d1: D1Database): Promise<string[]> {
  const rows = await d1
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'targeting_rules' ORDER BY name",
    )
    .all<{ name: string }>();
  return rows.results.map((row) => row.name);
}
