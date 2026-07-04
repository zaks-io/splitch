import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import worker from "../src/index.js";

const NOW_MS = Date.UTC(2026, 6, 3, 8, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();
const EXPIRED_ISO = "2026-07-02T08:00:00.000Z";
const FUTURE_ISO = "2026-07-04T08:00:00.000Z";

beforeAll(async () => {
  await ensureIdentitySchema(env.DB);
});

describe("Control Plane API scheduled demo reaper", () => {
  it("purges only expired provisional Organizations and their scoped children", async () => {
    const expired = await seedDemoOrg("org_reaper_expired", {
      provisional: true,
      demoExpiresAt: EXPIRED_ISO,
    });
    const future = await seedDemoOrg("org_reaper_future", {
      provisional: true,
      demoExpiresAt: FUTURE_ISO,
    });
    const claimed = await seedDemoOrg("org_reaper_claimed_expired", {
      provisional: false,
      demoExpiresAt: EXPIRED_ISO,
    });

    await runScheduled();

    await expectOrgRemoved(expired);
    await expectOrgPresent(future);
    await expectOrgPresent(claimed);
  });
});

async function runScheduled(): Promise<void> {
  const waits: Promise<unknown>[] = [];
  worker.scheduled?.(
    {
      cron: "0 8 * * *",
      scheduledTime: NOW_MS,
      noRetry: vi.fn(),
    } as ScheduledController,
    { ...env, SPLITCH_PLATFORM_TARGET: "local" } as ControlPlaneApiEnv,
    {
      waitUntil: (promise) => waits.push(promise),
    } as unknown as ExecutionContext,
  );
  await Promise.all(waits);
}

interface DemoOrgOptions {
  provisional: boolean;
  demoExpiresAt: string;
}

interface SeededDemoOrg {
  orgId: string;
  appIds: string[];
  environmentIds: string[];
  childRefs: RowRef[];
}

async function seedDemoOrg(orgId: string, options: DemoOrgOptions): Promise<SeededDemoOrg> {
  await env.DB.prepare(
    `
      INSERT INTO organizations (
        id, name, plan, is_provisional, demo_expires_at, created_at, updated_at
      )
      VALUES (?, ?, 'free', ?, ?, ?, ?)
    `,
  )
    .bind(
      orgId,
      `${orgId} name`,
      options.provisional ? 1 : 0,
      options.demoExpiresAt,
      NOW_ISO,
      NOW_ISO,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(orgId, `${orgId}_owner`, "owner", NOW_ISO)
    .run();
  await env.DB.prepare("INSERT INTO trusted_idps (idp_id, org_id) VALUES (?, ?)")
    .bind(`${orgId}_idp`, orgId)
    .run();

  const appIds: string[] = [];
  const environmentIds: string[] = [];
  const childRefs: RowRef[] = [{ table: "trusted_idps", column: "org_id", value: orgId }];
  for (const suffix of ["one", "two"]) {
    const appId = `${orgId}_app_${suffix}`;
    const environmentId = `${appId}_env`;
    appIds.push(appId);
    environmentIds.push(environmentId);
    await env.DB.prepare(
      `
        INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
      .bind(appId, orgId, `${orgId} ${suffix}`, `${orgId}-${suffix}`, NOW_ISO, NOW_ISO, "user")
      .run();
    await env.DB.prepare(
      "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(appId, `${orgId}_owner`, "owner", NOW_ISO)
      .run();
    await env.DB.prepare(
      `
        INSERT INTO environments (id, app_id, key, name, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
      .bind(environmentId, appId, "production", "Production", NOW_ISO, NOW_ISO, "user")
      .run();
    childRefs.push(...(await seedAppChildren(orgId, appId, environmentId)));
  }
  return { orgId, appIds, environmentIds, childRefs };
}

async function seedAppChildren(
  orgId: string,
  appId: string,
  environmentId: string,
): Promise<RowRef[]> {
  const flagId = `${appId}_flag`;
  const variantId = `${appId}_variant`;
  const experimentId = `${appId}_experiment`;
  const metricId = `${appId}_metric`;
  const targetingHash = `${appId}_targeting_hash`;
  const refs: RowRef[] = [
    { table: "flags", column: "id", value: flagId },
    { table: "variants", column: "id", value: variantId },
    { table: "flag_configs", column: "flag_id", value: flagId },
    { table: "targeting_rules", column: "flag_id", value: flagId },
    { table: "segments", column: "app_id", value: appId },
    { table: "metrics", column: "id", value: metricId },
    { table: "experiments", column: "id", value: experimentId },
    { table: "runs", column: "experiment_id", value: experimentId },
    { table: "api_keys", column: "app_id", value: appId },
    { table: "client_keys", column: "app_id", value: appId },
    { table: "entity_deletions", column: "targeting_key_hash", value: targetingHash },
    { table: "privacy_requests", column: "app_id", value: appId },
  ];

  await env.DB.prepare("INSERT INTO flags (id, app_id) VALUES (?, ?)").bind(flagId, appId).run();
  await env.DB.prepare("INSERT INTO variants (id, flag_id) VALUES (?, ?)")
    .bind(variantId, flagId)
    .run();
  await env.DB.prepare(
    "INSERT INTO flag_configs (id, app_id, environment_id, flag_id) VALUES (?, ?, ?, ?)",
  )
    .bind(`${appId}_flag_config`, appId, environmentId, flagId)
    .run();
  await env.DB.prepare(
    "INSERT INTO targeting_rules (id, app_id, environment_id, flag_id) VALUES (?, ?, ?, ?)",
  )
    .bind(`${appId}_targeting_rule`, appId, environmentId, flagId)
    .run();
  await env.DB.prepare("INSERT INTO segments (id, app_id) VALUES (?, ?)")
    .bind(`${appId}_segment`, appId)
    .run();
  await env.DB.prepare("INSERT INTO metrics (id, app_id) VALUES (?, ?)")
    .bind(metricId, appId)
    .run();
  await env.DB.prepare(
    "INSERT INTO experiments (id, app_id, environment_id, flag_id) VALUES (?, ?, ?, ?)",
  )
    .bind(experimentId, appId, environmentId, flagId)
    .run();
  await env.DB.prepare(
    "INSERT INTO runs (id, app_id, environment_id, experiment_id) VALUES (?, ?, ?, ?)",
  )
    .bind(`${appId}_run`, appId, environmentId, experimentId)
    .run();
  await env.DB.prepare("INSERT INTO api_keys (key_id, app_id, environment_id) VALUES (?, ?, ?)")
    .bind(`${appId}_api_key`, appId, environmentId)
    .run();
  await env.DB.prepare("INSERT INTO client_keys (key_id, app_id, environment_id) VALUES (?, ?, ?)")
    .bind(`${appId}_client_key`, appId, environmentId)
    .run();
  await env.DB.prepare(
    "INSERT INTO entity_deletions (app_id, id_type, targeting_key_hash, delete_before_ts, requested_at) VALUES (?, 'user', ?, ?, ?)",
  )
    .bind(appId, targetingHash, NOW_ISO, NOW_ISO)
    .run();
  await env.DB.prepare("INSERT INTO privacy_requests (request_id, org_id, app_id) VALUES (?, ?, ?)")
    .bind(`${appId}_privacy_request`, orgId, appId)
    .run();

  return refs;
}

async function expectOrgRemoved(org: SeededDemoOrg): Promise<void> {
  expect(await count("organizations", "id", org.orgId)).toBe(0);
  expect(await count("org_memberships", "org_id", org.orgId)).toBe(0);
  for (const appId of org.appIds) {
    expect(await count("apps", "id", appId)).toBe(0);
    expect(await count("app_memberships", "app_id", appId)).toBe(0);
  }
  for (const environmentId of org.environmentIds) {
    expect(await count("environments", "id", environmentId)).toBe(0);
  }
  for (const ref of org.childRefs) {
    expect(await count(ref.table, ref.column, ref.value)).toBe(0);
  }
}

async function expectOrgPresent(org: SeededDemoOrg): Promise<void> {
  expect(await count("organizations", "id", org.orgId)).toBe(1);
  expect(await count("org_memberships", "org_id", org.orgId)).toBe(1);
  for (const appId of org.appIds) {
    expect(await count("apps", "id", appId)).toBe(1);
    expect(await count("app_memberships", "app_id", appId)).toBe(1);
  }
  for (const environmentId of org.environmentIds) {
    expect(await count("environments", "id", environmentId)).toBe(1);
  }
  for (const ref of org.childRefs) {
    expect(await count(ref.table, ref.column, ref.value)).toBe(1);
  }
}

async function count(table: TableName, column: string, value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

interface RowRef {
  table: TableName;
  column: string;
  value: string;
}

type TableName =
  | "api_keys"
  | "app_memberships"
  | "apps"
  | "client_keys"
  | "entity_deletions"
  | "environments"
  | "experiments"
  | "flag_configs"
  | "flags"
  | "metrics"
  | "organizations"
  | "org_memberships"
  | "privacy_requests"
  | "runs"
  | "segments"
  | "targeting_rules"
  | "trusted_idps"
  | "variants";

async function ensureIdentitySchema(d1: D1Database): Promise<void> {
  const schema = [
    `CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, plan TEXT DEFAULT 'free' NOT NULL, stripe_customer_id TEXT, stripe_subscription_id TEXT, sso_enabled INTEGER DEFAULT 0 NOT NULL, is_provisional INTEGER DEFAULT 0 NOT NULL, demo_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS org_memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS apps_org_key_unique ON apps (organization_id, key)`,
    `CREATE TABLE IF NOT EXISTS app_memberships (app_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (app_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, policy TEXT DEFAULT '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}' NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS environments_app_key_unique ON environments (app_id, key)`,
    `CREATE TABLE IF NOT EXISTS flags (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS variants (id TEXT PRIMARY KEY NOT NULL, flag_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS flag_configs (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, flag_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS targeting_rules (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, flag_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS metrics (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, flag_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, experiment_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS api_keys (key_id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS client_keys (key_id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS entity_deletions (app_id TEXT NOT NULL, id_type TEXT NOT NULL, targeting_key_hash TEXT NOT NULL, delete_before_ts TEXT NOT NULL, requested_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS privacy_requests (request_id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL, app_id TEXT)`,
    `CREATE TABLE IF NOT EXISTS trusted_idps (idp_id TEXT PRIMARY KEY NOT NULL, org_id TEXT)`,
  ];
  for (const statement of schema) await d1.exec(statement);
}
