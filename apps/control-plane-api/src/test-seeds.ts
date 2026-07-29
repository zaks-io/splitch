/**
 * D1 seed helpers, deliberately free of any Miniflare import.
 *
 * Tests run in two runtimes: Node (Miniflare's magic proxy) and inside workerd
 * (the Workers pool). Miniflare cannot load inside workerd -- it pulls in
 * `node:process` via chalk -- so anything a pool test needs has to live apart
 * from the harness that constructs a Miniflare instance.
 */

export interface SeedRow {
  orgId: string;
  orgName: string;
  /** Defaults to `orgId`; set it only when the test asserts on the handle. */
  orgSlug?: string;
  appId: string;
  appName: string;
  appKey: string;
}

const NOW = "2026-06-29T00:00:00.000Z";

/** Insert one Org + its App (the roots are above the App tenant boundary). */
export async function seedOrgApp(d1: D1Database, row: SeedRow): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    // Defaults to the id, exactly like migration 0014's backfill: unique without
    // needing every caller to invent a handle it does not care about.
    .bind(row.orgId, row.orgName, row.orgSlug ?? row.orgId, "free", NOW, NOW)
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

export interface SeedAppMember {
  appId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  createdAt?: string;
}

export async function seedAppMember(d1: D1Database, row: SeedAppMember): Promise<void> {
  await d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(row.appId, row.userId, row.role, row.createdAt ?? NOW)
    .run();
}

export interface SeedEnvironment {
  appId: string;
  environmentId: string;
  key: string;
  name?: string;
  policy?: string;
}

export async function seedEnvironment(d1: D1Database, row: SeedEnvironment): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      row.environmentId,
      row.appId,
      row.key,
      row.name ?? row.key,
      row.policy ??
        '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}',
      NOW,
      NOW,
    )
    .run();
}
