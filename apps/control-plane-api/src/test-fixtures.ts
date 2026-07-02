import { Miniflare } from "miniflare";

/**
 * Local fixture substrate for the control-plane auth-middleware tests.
 *
 * A Miniflare local D1 carries only the roots the mounted handlers read/write
 * (organizations, org_memberships, apps); the full migration set is gated by
 * @splitch/db's own suite, so this test stays self-contained. A Miniflare local
 * KV backs the session-validation hot read. No real WorkOS, no network.
 */

const SCHEMA = [
  `CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, plan TEXT DEFAULT 'free' NOT NULL, stripe_customer_id TEXT, stripe_subscription_id TEXT, sso_enabled INTEGER DEFAULT 0 NOT NULL, is_provisional INTEGER DEFAULT 0 NOT NULL, demo_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE org_memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id))`,
  `CREATE TABLE apps (id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX apps_org_key_unique ON apps (organization_id, key)`,
];

export interface LocalBindings {
  d1: D1Database;
  kv: KVNamespace;
  dispose: () => Promise<void>;
}

export async function makeLocalBindings(): Promise<LocalBindings> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: { SESSION_STORE: "sessions" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  const kv = (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace;
  for (const statement of SCHEMA) {
    await d1.exec(statement);
  }
  return { d1, kv, dispose: () => mf.dispose() };
}

export interface SeedRow {
  orgId: string;
  orgName: string;
  appId: string;
  appName: string;
  appKey: string;
}

const NOW = "2026-06-29T00:00:00.000Z";

/** Insert one Org + its App (the roots are above the App tenant boundary). */
export async function seedOrgApp(d1: D1Database, row: SeedRow): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO organizations (id, name, plan, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
    .bind(row.orgId, row.orgName, "free", NOW, NOW)
    .run();
  await d1
    .prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(row.appId, row.orgId, row.appName, row.appKey, NOW, NOW)
    .run();
}

export interface SeedOrgMember {
  orgId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  createdAt?: string;
}

export async function seedOrgMember(d1: D1Database, row: SeedOrgMember): Promise<void> {
  await d1
    .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(row.orgId, row.userId, row.role, row.createdAt ?? NOW)
    .run();
}
