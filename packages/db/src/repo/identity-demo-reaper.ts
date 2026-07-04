import { and, eq, isNotNull, lt } from "drizzle-orm";
import { organizations } from "../schema/index";
import type { Db } from "./client";

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
  const statements = [
    ...APP_CHILD_DELETE_ORDER.map((spec) => deleteAppScopedRowsForOrg(d1, spec, orgId, nowIso)),
    deleteVariantsForOrg(d1, orgId, nowIso),
    deleteAppScopedRowsForOrg(d1, { table: "flags", returning: "id" }, orgId, nowIso),
    deleteAppScopedRowsForOrg(d1, { table: "environments", returning: "id" }, orgId, nowIso),
    deleteAppScopedRowsForOrg(d1, { table: "app_memberships", returning: "app_id" }, orgId, nowIso),
    deletePrivacyRequestsForOrg(d1, orgId, nowIso),
    deleteAppsForOrg(d1, orgId, nowIso),
    deleteOrgMembershipsForOrg(d1, orgId, nowIso),
    deleteTrustedIdpsForOrg(d1, orgId, nowIso),
    deleteExpiredOrgRoot(d1, orgId, nowIso),
  ];
  // D1 batch is the transaction boundary; each statement repeats the expiry
  // guard so a claimed or unexpired Organization becomes a 0-row no-op.
  const results = await d1.batch(statements);
  return (results[results.length - 1]?.results ?? []).length === 1;
}

const EXPIRED_ORG_EXISTS_SQL = `
  SELECT 1
  FROM organizations
  WHERE id = ?
    AND is_provisional = 1
    AND demo_expires_at IS NOT NULL
    AND demo_expires_at < ?
`;

const APP_IDS_FOR_ORG_SQL = "SELECT id FROM apps WHERE organization_id = ?";

interface AppScopedDeleteSpec {
  table:
    | "runs"
    | "flag_configs"
    | "targeting_rules"
    | "experiments"
    | "api_keys"
    | "client_keys"
    | "entity_deletions"
    | "segments"
    | "metrics"
    | "flags"
    | "environments"
    | "app_memberships";
  returning: "id" | "key_id" | "app_id";
}

const APP_CHILD_DELETE_ORDER: readonly AppScopedDeleteSpec[] = [
  { table: "runs", returning: "id" },
  { table: "flag_configs", returning: "id" },
  { table: "targeting_rules", returning: "id" },
  { table: "experiments", returning: "id" },
  { table: "api_keys", returning: "key_id" },
  { table: "client_keys", returning: "key_id" },
  { table: "entity_deletions", returning: "app_id" },
  { table: "segments", returning: "id" },
  { table: "metrics", returning: "id" },
];

function deleteAppScopedRowsForOrg(
  d1: D1Database,
  spec: AppScopedDeleteSpec,
  orgId: string,
  nowIso: string,
) {
  // Table identifiers come only from AppScopedDeleteSpec; caller values stay bound.
  return d1
    .prepare(
      `
      DELETE FROM ${spec.table}
      WHERE app_id IN (${APP_IDS_FOR_ORG_SQL})
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING ${spec.returning}
    `,
    )
    .bind(orgId, orgId, nowIso);
}

function deleteVariantsForOrg(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM variants
      WHERE flag_id IN (
        SELECT id FROM flags WHERE app_id IN (${APP_IDS_FOR_ORG_SQL})
      )
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING id
    `,
    )
    .bind(orgId, orgId, nowIso);
}

function deletePrivacyRequestsForOrg(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM privacy_requests
      WHERE (org_id = ? OR app_id IN (${APP_IDS_FOR_ORG_SQL}))
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING request_id
    `,
    )
    .bind(orgId, orgId, orgId, nowIso);
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

function deleteTrustedIdpsForOrg(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM trusted_idps
      WHERE org_id = ?
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING idp_id
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
