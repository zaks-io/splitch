import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createLocalD1 } from "./repo/test-d1";
import { claimVerifications } from "./schema";

/**
 * Asserts the GENERATED migration SQL — the exact DDL `wrangler d1 migrations
 * apply` runs — carries the co-scoping columns and the storage-only `runs`
 * columns. Reading the emitted SQL (not the TS schema) proves drizzle-kit
 * actually emitted them, which is what the local D1 gate applies.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function loadMigrationSql(): string {
  const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  expect(sqlFiles.length).toBeGreaterThan(0);
  return sqlFiles.map((f) => readFileSync(join(migrationsDir, f), "utf8")).join("\n");
}

/** Extract the column block of one `CREATE TABLE \`name\` ( ... );` statement. */
function tableBlock(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE \`${table}\` (`);
  expect(start, `table ${table} present`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(");", start);
  return sql.slice(start, end);
}

const migrationSql = loadMigrationSql();

// Tables that carry a direct app_id column the data-access seam filters on
// (ADR-0018). `apps` is excluded — it is the tenant root, scoped by its own `id`
// PK, not a separate app_id column. `variants` is excluded too: per the storage
// spec the Variant catalog is reached transitively via flag_id → flags.app_id
// and carries no app_id column of its own.
const tenantTables = [
  "app_memberships",
  "environments",
  "flags",
  "flag_configs",
  "targeting_rules",
  "segments",
  "experiments",
  "runs",
  "metrics",
  "client_keys",
  "api_keys",
  "entity_deletions",
];

// Per-Environment tables additionally co-scope on environment_id (ADR-0027).
const perEnvironmentTables = [
  "flag_configs",
  "targeting_rules",
  "experiments",
  "runs",
  "client_keys",
  "api_keys",
];

describe("D1 co-scoping columns", () => {
  it.each(tenantTables)("%s has an app_id column", (table) => {
    expect(tableBlock(migrationSql, table)).toContain("`app_id`");
  });

  it.each(perEnvironmentTables)("%s has an environment_id column", (table) => {
    expect(tableBlock(migrationSql, table)).toContain("`environment_id`");
  });

  it("variants stays App-level (flag-scoped, no environment_id)", () => {
    expect(tableBlock(migrationSql, "variants")).not.toContain("`environment_id`");
  });

  it("environments carries inline Environment Policy storage", () => {
    expect(migrationSql).toContain("ALTER TABLE `environments` ADD `policy` text");
  });
});

describe("runs storage-only decision columns", () => {
  // These live ONLY on the D1 runs table — the S02 Run Zod leaf omits them.
  const storageOnlyColumns = [
    "`run_number`",
    "`targeting_key_field`",
    "`decision_family`",
    "`horizon`",
    "`target_n`",
    "`sample_size_locked`",
    "`guardrail_decisions`",
    "`start_reason`",
    "`end_reason`",
    "`confidence_level`",
  ];

  // The frozen-Run snapshot + run-level immutables.
  const frozenSnapshotColumns = [
    "`salt`",
    "`allocation`",
    "`variant_set`",
    "`targeting_rules`",
    "`config_hash`",
  ];

  const runsBlock = tableBlock(migrationSql, "runs");

  it.each(storageOnlyColumns)("runs carries %s", (column) => {
    expect(runsBlock).toContain(column);
  });

  it.each(frozenSnapshotColumns)("runs carries frozen-snapshot %s", (column) => {
    expect(runsBlock).toContain(column);
  });

  it("enforces run_number + salt uniqueness per Experiment", () => {
    expect(migrationSql).toContain("`runs_experiment_run_number_unique`");
    expect(migrationSql).toContain("`runs_experiment_salt_unique`");
  });
});

describe("credential invariants", () => {
  it("enforces one active Client Key per Environment", () => {
    expect(migrationSql).toContain("`client_keys_active_env_unique`");
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX `client_keys_active_env_unique` ON `client_keys` (`app_id`,`environment_id`) WHERE revoked_at IS NULL",
    );
  });
});

describe("full table corpus", () => {
  it("applies the 22 named live D1 tables", async () => {
    const local = await createLocalD1();
    try {
      const tables = await local.d1
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_METADATA'",
        )
        .all<{ name: string }>();
      expect(tables.results.map((table) => table.name).sort()).toEqual([
        "api_keys",
        "app_memberships",
        "apps",
        "claim_consent_attempts",
        "claim_idempotency",
        "claim_verifications",
        "client_keys",
        "device_refresh_sessions",
        "entity_deletions",
        "environments",
        "experiments",
        "flag_configs",
        "flags",
        "metrics",
        "org_memberships",
        "organizations",
        "privacy_requests",
        "runs",
        "segments",
        "targeting_rules",
        "trusted_idps",
        "variants",
      ]);
    } finally {
      await local.dispose();
    }
  });
});

describe("device refresh session storage", () => {
  const block = tableBlock(migrationSql, "device_refresh_sessions");

  it("stores provider session id keyed by a refresh token hash", () => {
    expect(block).toContain("`refresh_token_hash`");
    expect(block).toContain("`provider_session_id`");
    expect(migrationSql).toContain("`provider_organization_id`");
    expect(migrationSql).toContain("`selected_app_scope`");
  });

  it("does not add a raw refresh_token column", () => {
    expect(block).not.toContain("`refresh_token`");
  });
});

describe("Door B verification resource authority", () => {
  it("keeps selected_resource in the canonical Drizzle schema and migrations", () => {
    expect(getTableColumns(claimVerifications).selectedResource?.name).toBe("selected_resource");
    expect(migrationSql).toContain(
      "ALTER TABLE `claim_verifications` ADD `selected_resource` text",
    );
  });
});

describe("Door B transfer acquisition storage", () => {
  it("stores a nullable one-batch acquisition marker on Organizations", () => {
    expect(migrationSql).toContain("ALTER TABLE `organizations` ADD `claim_acquired_at` text");
    expect(migrationSql).toContain(
      "ALTER TABLE `organizations` ADD `claim_acquisition_token` text",
    );
  });
});
