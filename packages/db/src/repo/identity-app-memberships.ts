import { asc, eq } from "drizzle-orm";
import { appMemberships } from "../schema/index";
import type { Db } from "./client";
import type { TenantScope } from "./scope";
import { type ReadOptions, scopedTable } from "./scoped-table";

/**
 * The App's own access list (`app_memberships`), distinct from Organization
 * membership.
 *
 * Every read and write goes through the scope-bound table, so `app_id` is
 * stamped from the minted scope and never taken from a caller's payload
 * (ADR-0018 — D1 has no RLS, so this seam is the tenant boundary).
 *
 * Split out of `identity.ts` so that file stays inside the repo file-size guard.
 */
export function makeAppMembershipRepo(db: Db) {
  const table = scopedTable(db, appMemberships);

  return {
    table,

    listAppMembers(scope: TenantScope, options?: ReadOptions) {
      return table.findMany(scope, undefined, {
        ...options,
        orderBy: options?.orderBy ?? [asc(appMemberships.createdAt), asc(appMemberships.userId)],
      });
    },

    getAppMembership(scope: TenantScope, userId: string) {
      return table.findOne(scope, eq(appMemberships.userId, userId));
    },

    createAppMembership(
      scope: TenantScope,
      values: Omit<typeof appMemberships.$inferInsert, "appId">,
    ) {
      return table.insert(scope, values as typeof appMemberships.$inferInsert);
    },

    updateAppMembership(
      scope: TenantScope,
      userId: string,
      values: Partial<Pick<typeof appMemberships.$inferInsert, "role">>,
    ) {
      return table
        .update(scope, values, eq(appMemberships.userId, userId))
        .then((rows) => rows[0] ?? null);
    },

    deleteAppMembership(scope: TenantScope, userId: string) {
      return table.remove(scope, eq(appMemberships.userId, userId));
    },

    deleteAppMemberships(scope: TenantScope) {
      return table.remove(scope);
    },

    countAppOwnerMemberships(scope: TenantScope) {
      return table.countRows(scope, eq(appMemberships.role, "owner"));
    },
  };
}
