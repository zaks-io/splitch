import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { applySchema, migrationFileStatements, migrationStatementsThrough } from "./repo/test-d1";

const CREATED_AT = "2026-08-20T10:00:00.000Z";
const MIGRATION = "0027_sentry_org_scope.sql";

interface InstallationRow {
  installation_id: string;
  org_id: string;
  status: string;
  revoked_at: string | null;
  last_delivered_seq: number | null;
  secret_ciphertext: string;
}

let mf: Miniflare | undefined;

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

/**
 * Two Environments of one App could each hold an active Sentry installation, and
 * a scripted setup creates them in the same second. The rebuild has to collapse
 * that fan-out to exactly one active row per Organization before it builds the
 * partial unique index, because by then the old table is gone and a failure
 * leaves the database half-migrated.
 */
describe("Sentry Organization-scope migration", () => {
  it("keeps one active installation per Organization when created_at ties", async () => {
    const d1 = await migratedThrough0026();
    await seedOrganization(d1, "org_a", "app_a");
    await seedInstallation(d1, {
      id: "inst_a1",
      appId: "app_a",
      envId: "env_a1",
      status: "active",
    });
    await seedInstallation(d1, {
      id: "inst_a2",
      appId: "app_a",
      envId: "env_a2",
      status: "active",
    });

    await applySchema(d1, migrationFileStatements(MIGRATION));

    const rows = await installations(d1);
    expect(rows.map((row) => row.org_id)).toEqual(["org_a", "org_a"]);
    expect(rows.filter((row) => row.status === "active").map((row) => row.installation_id)).toEqual(
      ["inst_a2"],
    );
    const revoked = rows.find((row) => row.status === "revoked");
    expect(revoked?.revoked_at).not.toBeNull();
  });

  it("carries every Organization's cursor and sealed secret across the rebuild", async () => {
    const d1 = await migratedThrough0026();
    await seedOrganization(d1, "org_a", "app_a");
    await seedOrganization(d1, "org_b", "app_b");
    await seedInstallation(d1, {
      id: "inst_a1",
      appId: "app_a",
      envId: "env_a1",
      status: "active",
      lastDeliveredSeq: 41,
    });
    await seedInstallation(d1, {
      id: "inst_b1",
      appId: "app_b",
      envId: "env_b1",
      status: "active",
    });

    await applySchema(d1, migrationFileStatements(MIGRATION));

    expect(await installations(d1)).toEqual([
      expect.objectContaining({
        installation_id: "inst_a1",
        org_id: "org_a",
        status: "active",
        last_delivered_seq: 41,
        secret_ciphertext: "sealed:inst_a1",
      }),
      expect.objectContaining({
        installation_id: "inst_b1",
        org_id: "org_b",
        status: "active",
        secret_ciphertext: "sealed:inst_b1",
      }),
    ]);
  });
});

async function migratedThrough0026(): Promise<D1Database> {
  mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applySchema(d1, migrationStatementsThrough("0026_flag_change_log.sql"));
  return d1;
}

async function installations(d1: D1Database): Promise<InstallationRow[]> {
  const { results } = await d1
    .prepare("SELECT * FROM sentry_installations ORDER BY installation_id")
    .all<InstallationRow>();
  return results;
}

async function seedOrganization(d1: D1Database, orgId: string, appId: string): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?, ?, ?, 'free', ?, ?)",
    )
    .bind(orgId, orgId, orgId, CREATED_AT, CREATED_AT)
    .run();
  await d1
    .prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 'user_seed')",
    )
    .bind(appId, orgId, appId, appId, CREATED_AT, CREATED_AT)
    .run();
}

async function seedInstallation(
  d1: D1Database,
  install: {
    id: string;
    appId: string;
    envId: string;
    status: "active" | "revoked";
    lastDeliveredSeq?: number;
  },
): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO environments (id, app_id, key, name, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 'user_seed')",
    )
    .bind(install.envId, install.appId, install.envId, install.envId, CREATED_AT, CREATED_AT)
    .run();
  await d1
    .prepare(
      `INSERT INTO sentry_installations (
         installation_id, app_id, environment_id, webhook_url, secret_ciphertext, secret_key_version,
         secret_fingerprint, status, last_delivered_seq, attempt_count, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'v1', 'fingerprint', ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      install.id,
      install.appId,
      install.envId,
      "https://sentry.io/api/0/organizations/acme/flags/hooks/provider/generic/",
      `sealed:${install.id}`,
      install.status,
      install.lastDeliveredSeq ?? null,
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
    )
    .run();
}
