import { and, asc, eq } from "drizzle-orm";
import {
  apps,
  deviceRefreshSessions,
  environments,
  organizations,
  orgMemberships,
} from "../schema/index";
import { makeDeleteAppCascade } from "./app-delete-cascade";
import { makeAppDeletionSagaRepo } from "./app-deletion-sagas";
import type { Db } from "./client";
import { makeAppCreateIdempotencyRepo } from "./identity-app-create-idempotency";
import { makeAppMembershipRepo } from "./identity-app-memberships";
import { makeDemoReaper } from "./identity-demo-reaper";
import { makeOrgMutations } from "./identity-org-mutations";
import { makeOrgReads } from "./identity-org-reads";
import { makeIdentitySelectorReads } from "./identity-selector-reads";
import { makeSessionReads } from "./identity-session-reads";
import { makeCreateOrganization } from "./organization-create";
import type { TenantScope } from "./scope";
import { type ReadOptions, scopedTable } from "./scoped-table";

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
export function makeIdentityRepo(db: Db, d1: D1Database) {
  const environmentsTable = scopedTable(db, environments);
  const appMembershipRepo = makeAppMembershipRepo(db);
  const orgMutations = makeOrgMutations(db);
  const sessionReads = makeSessionReads(db);
  const demoReaper = makeDemoReaper(db, d1);
  const createOrganization = makeCreateOrganization(db, d1);
  const deleteAppCascade = makeDeleteAppCascade(d1);
  const appDeletionSagaRepo = makeAppDeletionSagaRepo(d1);
  const appCreateIdempotencyRepo = makeAppCreateIdempotencyRepo(db);
  const orgReads = makeOrgReads(db);
  const selectorReads = makeIdentitySelectorReads(db);

  return {
    environments: environmentsTable,
    appMemberships: appMembershipRepo.table,
    deleteAppCascade,
    ...appDeletionSagaRepo,

    // Creation order is the order operators think in (dev before prod), and every
    // Panel surface that lists Environments renders straight from this read, so the
    // order is fixed here rather than re-sorted per caller. Key breaks a timestamp
    // tie because ids are random: two Environments stamped in the same millisecond
    // would otherwise swap between reads.
    listEnvironments(scope: TenantScope, options?: ReadOptions) {
      return environmentsTable.findMany(scope, undefined, {
        ...options,
        orderBy: options?.orderBy ?? [asc(environments.createdAt), asc(environments.key)],
      });
    },

    countEnvironments(scope: TenantScope) {
      return environmentsTable.countRows(scope);
    },

    getEnvironment(scope: TenantScope, environmentId: string) {
      return environmentsTable.findOne(scope, eq(environments.id, environmentId));
    },

    getEnvironmentByKey(scope: TenantScope, key: string) {
      return environmentsTable.findOne(scope, eq(environments.key, key));
    },

    updateEnvironment(
      scope: TenantScope,
      environmentId: string,
      values: Partial<Pick<typeof environments.$inferInsert, "name" | "policy" | "updatedAt">>,
    ) {
      return environmentsTable
        .update(scope, values, eq(environments.id, environmentId))
        .then((rows) => rows[0] ?? null);
    },

    deleteEnvironment(scope: TenantScope, environmentId: string) {
      return environmentsTable.remove(scope, eq(environments.id, environmentId));
    },

    ...appMembershipRepo,

    // --- Org-or-identity scoped (NOT app-scoped) -------------------------------

    ...orgReads,
    ...selectorReads,
    ...appCreateIdempotencyRepo,

    ...orgMutations,
    ...sessionReads,
    ...demoReaper,

    /**
     * Fetch a single App by its own id. The tenant root is reached by identity,
     * not by an app_id filter on a sibling-bearing table.
     */
    async getApp(appId: string): Promise<typeof apps.$inferSelect | null> {
      const rows = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
      return rows[0] ?? null;
    },

    // --- Provisioning writes (anon Door B; org-or-identity scoped) -------------
    //
    // The anonymous-register door (auth-doors.md Door B) mints a provisional Org +
    // App + Environment. These are NOT app-scoped writes — an Org sits ABOVE Apps,
    // and an App IS the tenant root being created — so they cannot route through
    // `scopedTable` (the same category boundary `getOrg`/`getApp` sit on). The
    // Environment, by contrast, IS app-scoped, so it is written through the
    // scope-bound `environments` table above, never here.

    /**
     * Creates the Org AND its owner membership atomically. There is deliberately
     * no way to create one without the other: an Org with no owner is
     * unreachable, since every Org route authorizes through live membership.
     */
    createOrganization,

    async createOrgMembership(
      values: typeof orgMemberships.$inferInsert,
    ): Promise<typeof orgMemberships.$inferSelect> {
      const rows = await db.insert(orgMemberships).values(values).returning();
      const inserted = rows[0];
      if (!inserted) {
        throw new Error("createOrgMembership: no row returned");
      }
      return inserted;
    },

    async createApp(values: typeof apps.$inferInsert): Promise<typeof apps.$inferSelect> {
      const rows = await db.insert(apps).values(values).returning();
      const inserted = rows[0];
      if (!inserted) {
        throw new Error("createApp: no row returned");
      }
      return inserted;
    },

    async updateApp(
      appId: string,
      values: Partial<Pick<typeof apps.$inferInsert, "name" | "key" | "description" | "updatedAt">>,
    ): Promise<typeof apps.$inferSelect | null> {
      const rows = await db.update(apps).set(values).where(eq(apps.id, appId)).returning();
      return rows[0] ?? null;
    },

    async deleteApp(appId: string): Promise<number> {
      const rows = await db.delete(apps).where(eq(apps.id, appId)).returning();
      return rows.length;
    },

    /**
     * Clear the provisional flag on an Org (the claim ceremony, auth-doors.md
     * step 4). Bound to the Org's own id and to `is_provisional = 1` so a replay
     * after a successful claim is a 0-row no-op the caller can detect, and a
     * non-provisional Org can never be silently re-cleared. Drops
     * `demo_expires_at` to NULL in the same write so the
     * `is_provisional=1 ⇒ demo_expires_at IS NOT NULL` invariant holds either way.
     */
    async clearProvisional(orgId: string, updatedAtIso: string): Promise<number> {
      const rows = await db
        .update(organizations)
        .set({ isProvisional: false, demoExpiresAt: null, updatedAt: updatedAtIso })
        .where(and(eq(organizations.id, orgId), eq(organizations.isProvisional, true)))
        .returning();
      return rows.length;
    },

    rememberDeviceRefreshSession(values: typeof deviceRefreshSessions.$inferInsert) {
      return db
        .insert(deviceRefreshSessions)
        .values(values)
        .onConflictDoUpdate({
          target: deviceRefreshSessions.refreshTokenHash,
          set: {
            providerSessionId: values.providerSessionId,
            createdAt: values.createdAt,
          },
        });
    },

    async getDeviceRefreshSession(
      refreshTokenHash: string,
    ): Promise<typeof deviceRefreshSessions.$inferSelect | null> {
      const rows = await db
        .select()
        .from(deviceRefreshSessions)
        .where(eq(deviceRefreshSessions.refreshTokenHash, refreshTokenHash))
        .limit(1);
      return rows[0] ?? null;
    },

    deleteDeviceRefreshSession(refreshTokenHash: string) {
      return db
        .delete(deviceRefreshSessions)
        .where(eq(deviceRefreshSessions.refreshTokenHash, refreshTokenHash));
    },
  };
}
