import { and, eq } from "drizzle-orm";
import {
  appMemberships,
  apps,
  environments,
  organizations,
  orgMemberships,
} from "../schema/index.js";
import type { Db } from "./client.js";
import type { TenantScope } from "./scope.js";
import { scopedTable } from "./scoped-table.js";

/**
 * Identity-domain repository.
 *
 * Two scoping regimes live here, deliberately kept distinct (ADR-0018 /
 * ADR-0021):
 *
 *  - APP-SCOPED (tenant boundary): environments, app_memberships. These carry
 *    `app_id` and route through the scope-bound `scopedTable`, so they get the
 *    same non-skippable `WHERE app_id = ?` as every other tenant table.
 *
 *  - ORG-OR-IDENTITY-SCOPED (NOT app-scoped): organizations, org_memberships,
 *    apps. An Org sits ABOVE Apps, so forcing an `app_id` filter on it is wrong;
 *    these are scoped by `org_id` (membership/listing) or by their own primary
 *    key (a single Org/App fetch). They do NOT use `scopedTable` — using the
 *    tenant helper here would be a category error.
 *
 * `apps` is the tenant ROOT: it is fetched by its own id and listed by org_id.
 * Authorization that a caller may see a given App is the Worker's job (token
 * scopes); this layer enforces that an App is only ever reached via its own id
 * or its parent Org, never via a sibling App's scope.
 */
export function makeIdentityRepo(db: Db) {
  const environmentsTable = scopedTable(db, environments);
  const appMembershipsTable = scopedTable(db, appMemberships);

  return {
    environments: environmentsTable,
    appMemberships: appMembershipsTable,

    listEnvironments(scope: TenantScope) {
      return environmentsTable.findMany(scope);
    },

    getEnvironment(scope: TenantScope, environmentId: string) {
      return environmentsTable.findOne(scope, eq(environments.id, environmentId));
    },

    listAppMembers(scope: TenantScope) {
      return appMembershipsTable.findMany(scope);
    },

    // --- Org-or-identity scoped (NOT app-scoped) -------------------------------

    async getOrg(orgId: string): Promise<typeof organizations.$inferSelect | null> {
      const rows = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      return rows[0] ?? null;
    },

    listOrgMemberships(orgId: string) {
      return db.select().from(orgMemberships).where(eq(orgMemberships.orgId, orgId));
    },

    getOrgMembership(orgId: string, userId: string) {
      return db
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    /** Apps for an Org. Scoped by org_id (the tier above App), never by app_id. */
    listAppsForOrg(orgId: string) {
      return db.select().from(apps).where(eq(apps.organizationId, orgId));
    },

    /**
     * Fetch a single App by its own id. The tenant root is reached by identity,
     * not by an app_id filter on a sibling-bearing table.
     */
    async getApp(appId: string): Promise<typeof apps.$inferSelect | null> {
      const rows = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
      return rows[0] ?? null;
    },
  };
}
