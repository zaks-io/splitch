import { and, eq, isNotNull, lt } from "drizzle-orm";
import { organizations } from "../schema/index";
import type { Db } from "./client";

export interface DemoReaperResult {
  candidates: number;
  reaped: number;
}

export function makeDemoReaper(db: Db, d1: D1Database) {
  return {
    async listExpiredProvisionalMembershipUserIds(nowIso: string): Promise<string[]> {
      const result = await d1
        .prepare(
          `
            SELECT memberships.user_id
            FROM org_memberships AS memberships
            INNER JOIN organizations AS organization ON organization.id = memberships.org_id
            WHERE organization.is_provisional = 1
              AND organization.demo_expires_at IS NOT NULL
              AND organization.demo_expires_at < ?
            UNION
            SELECT memberships.user_id
            FROM app_memberships AS memberships
            INNER JOIN apps AS app ON app.id = memberships.app_id
            INNER JOIN organizations AS organization ON organization.id = app.organization_id
            WHERE organization.is_provisional = 1
              AND organization.demo_expires_at IS NOT NULL
              AND organization.demo_expires_at < ?
          `,
        )
        .bind(nowIso, nowIso)
        .all<{ user_id: string }>();
      return result.results.map(({ user_id }) => user_id);
    },

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
  const results = await d1.batch(REAP_PLAN.map(([, build]) => build(d1, orgId, nowIso)));
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
  table: AppScopedTable;
  returning: "id" | "key_id" | "app_id" | "installation_id" | "delivery_id";
}

type AppScopedTable =
  | "cloudflare_config_deliveries"
  | "cloudflare_installations"
  | "config_webhook_deliveries"
  | "convex_installations"
  | "event_definition_versions"
  | "event_definitions"
  | "approval_reviews"
  | "approval_requests"
  | "runs"
  | "flag_configs"
  | "targeting_rules"
  | "experiments"
  | "api_keys"
  | "client_keys"
  | "entity_deletions"
  | "segments"
  | "metrics"
  | "app_deletion_sagas"
  | "flags"
  | "environments"
  | "app_memberships";

const APP_CHILD_DELETE_ORDER: readonly AppScopedDeleteSpec[] = [
  // Integration installations FK both the App and its Environments, and their
  // delivery logs FK the installation, so the whole integration subtree clears
  // before anything it points at.
  { table: "cloudflare_config_deliveries", returning: "delivery_id" },
  { table: "cloudflare_installations", returning: "installation_id" },
  { table: "config_webhook_deliveries", returning: "delivery_id" },
  { table: "convex_installations", returning: "installation_id" },
  { table: "event_definition_versions", returning: "id" },
  { table: "event_definitions", returning: "id" },
  { table: "approval_reviews", returning: "id" },
  { table: "approval_requests", returning: "id" },
  { table: "runs", returning: "id" },
  { table: "flag_configs", returning: "id" },
  { table: "targeting_rules", returning: "id" },
  { table: "experiments", returning: "id" },
  { table: "api_keys", returning: "key_id" },
  { table: "client_keys", returning: "key_id" },
  { table: "entity_deletions", returning: "app_id" },
  { table: "segments", returning: "id" },
  { table: "metrics", returning: "id" },
  // No foreign key of its own, but the App it recovers is about to vanish and
  // would leave the recovery row pointing at nothing.
  { table: "app_deletion_sagas", returning: "app_id" },
];

type ReapStep = readonly [table: string, build: DeleteBuilder];
type DeleteBuilder = (d1: D1Database, orgId: string, nowIso: string) => D1PreparedStatement;

/**
 * Every table the reap clears, in the order it clears them, and the sole source
 * for both the batch above and the coverage test that pins this list against the
 * applied D1 schema. A table carrying `app_id` that is missing here either
 * outlives the Organization or fails its foreign key when the App goes.
 */
const REAP_PLAN: readonly ReapStep[] = [
  ...appScopedSteps(APP_CHILD_DELETE_ORDER),
  ["variants", deleteVariantsForOrg],
  ...appScopedSteps([
    { table: "flags", returning: "id" },
    { table: "environments", returning: "id" },
    { table: "app_memberships", returning: "app_id" },
  ]),
  ["privacy_requests", deletePrivacyRequestsForOrg],
  // Written by triggers on every statement above, so it is cleared after them
  // and before the Apps whose history it is.
  ["flag_change_events", deleteFlagChangeEventsForOrg],
  ["apps", deleteAppsForOrg],
  // FKs the Organization row itself, so it must clear before the root delete.
  ["sentry_installations", deleteSentryInstallationsForOrg],
  ["org_memberships", deleteOrgMembershipsForOrg],
  ["trusted_idps", deleteTrustedIdpsForOrg],
  ["organizations", deleteExpiredOrgRoot],
];

export const DEMO_REAP_DELETE_ORDER: readonly string[] = REAP_PLAN.map(([table]) => table);

function appScopedSteps(specs: readonly AppScopedDeleteSpec[]): readonly ReapStep[] {
  return specs.map(
    (spec) =>
      [
        spec.table,
        (d1: D1Database, orgId: string, nowIso: string) =>
          deleteAppScopedRowsForOrg(d1, spec, orgId, nowIso),
      ] as const,
  );
}

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

function deleteFlagChangeEventsForOrg(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM flag_change_events
      WHERE app_id IN (${APP_IDS_FOR_ORG_SQL})
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING seq
    `,
    )
    .bind(orgId, orgId, nowIso);
}

function deleteSentryInstallationsForOrg(d1: D1Database, orgId: string, nowIso: string) {
  return d1
    .prepare(
      `
      DELETE FROM sentry_installations
      WHERE org_id = ?
        AND EXISTS (${EXPIRED_ORG_EXISTS_SQL})
      RETURNING installation_id
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
