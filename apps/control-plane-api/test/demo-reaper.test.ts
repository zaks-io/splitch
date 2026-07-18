import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import worker from "../src/index.js";
import { type RowRef, seedAppChildren, type TableName } from "./demo-reaper-fixture.js";

const NOW_MS = Date.UTC(2026, 6, 3, 8, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();
const EXPIRED_ISO = "2026-07-02T08:00:00.000Z";
const FUTURE_ISO = "2026-07-04T08:00:00.000Z";

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
    {
      ...env,
      CREDENTIAL_CACHE_BACKFILL: {
        getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      },
      SPLITCH_PLATFORM_TARGET: "local",
    } as ControlPlaneApiEnv,
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
  await env.DB.prepare(
    "INSERT INTO trusted_idps (idp_id, org_id, issuer, jwks_uri, client_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(`${orgId}_idp`, orgId, `https://${orgId}.test`, "https://jwks.test", "[]", NOW_ISO)
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
    childRefs.push(...(await seedAppChildren(env.DB, orgId, appId, environmentId, NOW_ISO)));
  }
  return { orgId, appIds, environmentIds, childRefs };
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
