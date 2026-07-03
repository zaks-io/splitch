import { and, eq, isNotNull, lt } from "drizzle-orm";
import { organizations } from "../schema/index.js";
import type { Db } from "./client.js";

export interface DemoReaperResult {
  candidates: number;
  reaped: number;
}

export function makeDemoReaper(db: Db, d1: D1Database) {
  return {
    async reapExpiredProvisionalOrganizations(nowIso: string): Promise<DemoReaperResult> {
      const candidates = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(expiredProvisionalOrgPredicate(nowIso));

      let reaped = 0;
      for (const org of candidates) {
        if (await deleteExpiredProvisionalOrg(d1, org.id, nowIso)) reaped += 1;
      }

      return { candidates: candidates.length, reaped };
    },
  };
}

function expiredProvisionalOrgPredicate(nowIso: string) {
  return and(
    eq(organizations.isProvisional, true),
    isNotNull(organizations.demoExpiresAt),
    lt(organizations.demoExpiresAt, nowIso),
  );
}

async function deleteExpiredProvisionalOrg(
  d1: D1Database,
  orgId: string,
  nowIso: string,
): Promise<boolean> {
  // D1 batch is the transaction boundary; each statement repeats the expiry
  // guard so a claimed or unexpired Organization becomes a 0-row no-op.
  const results = await d1.batch([
    deleteEnvironmentsForOrg(d1, orgId, nowIso),
    deleteAppMembershipsForOrg(d1, orgId, nowIso),
    deleteAppsForOrg(d1, orgId, nowIso),
    deleteOrgMembershipsForOrg(d1, orgId, nowIso),
    deleteExpiredOrgRoot(d1, orgId, nowIso),
  ]);
  return (results[4]?.results ?? []).length === 1;
}

const EXPIRED_ORG_EXISTS_SQL = `
  SELECT 1
  FROM organizations
  WHERE id = ?
    AND is_provisional = 1
    AND demo_expires_at IS NOT NULL
    AND demo_expires_at < ?
`;

function deleteEnvironmentsForOrg(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM environments
      WHERE app_id IN (SELECT id FROM apps WHERE organization_id = ?)
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING id
    `,
    )
    .bind(orgId, orgId, nowIso);
}

function deleteAppMembershipsForOrg(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM app_memberships
      WHERE app_id IN (SELECT id FROM apps WHERE organization_id = ?)
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING app_id
    `,
    )
    .bind(orgId, orgId, nowIso);
}

function deleteAppsForOrg(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM apps
      WHERE organization_id = ?
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING id
    `,
    )
    .bind(orgId, orgId, nowIso);
}

function deleteOrgMembershipsForOrg(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM org_memberships
      WHERE org_id = ?
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING org_id
    `,
    )
    .bind(orgId, orgId, nowIso);
}

function deleteExpiredOrgRoot(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM organizations
      WHERE id = ?
        AND is_provisional = 1
        AND demo_expires_at IS NOT NULL
        AND demo_expires_at < ?
      RETURNING id
    `,
    )
    .bind(orgId, nowIso);
}
