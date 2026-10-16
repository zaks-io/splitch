import { and, asc, eq, sql } from "drizzle-orm";
import { appMemberships } from "../schema/index";
import { type AuditContext, auditInsert } from "./audit-event-write";
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
 * Last-owner enforcement lives IN the UPDATE/DELETE predicate, not in a
 * preceding count. A pre-check read is racy: two concurrent demotions both see
 * two owners and both proceed. The owner-count subquery is the same statement
 * as the mutation, so SQLite serializes writers and the loser is a 0-row no-op
 * (SPL-484). Bulk `deleteAppMemberships` is the App-deletion path and must not
 * carry this guard — the App itself is going away.
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
      audit?: AuditContext,
    ) {
      if (audit)
        return db
          .batch([
            db
              .insert(appMemberships)
              .values({ ...values, appId: scope.appId })
              .returning(),
            auditInsert(db, scope, {
              ...audit,
              action: "app_members_add",
              resourceType: "app_membership",
              resourceId: values.userId,
              metadata: { role: values.role },
            }),
          ])
          .then(([rows]) => {
            if (!rows[0])
              throw new Error("createAppMembership: committed membership was not returned");
            return rows[0];
          });
      return table.insert(scope, values as typeof appMemberships.$inferInsert);
    },

    updateAppMembership(
      scope: TenantScope,
      userId: string,
      values: Pick<typeof appMemberships.$inferInsert, "role">,
      audit?: AuditContext,
    ) {
      if (audit)
        return db
          .batch([
            db
              .update(appMemberships)
              .set(values)
              .where(
                and(
                  eq(appMemberships.appId, scope.appId),
                  eq(appMemberships.userId, userId),
                  canChangeOwnerRole(scope, values.role),
                  sql`${appMemberships.role} <> ${values.role}`,
                ),
              )
              .returning(),
            auditInsert(db, scope, {
              ...audit,
              action: "app_members_update",
              resourceType: "app_membership",
              resourceId: userId,
              metadata: { role: values.role },
            }),
          ])
          .then(([rows]) => rows[0] ?? null);
      return table
        .update(
          scope,
          values,
          and(eq(appMemberships.userId, userId), canChangeOwnerRole(scope, values.role)),
        )
        .then((rows) => rows[0] ?? null);
    },

    deleteAppMembership(scope: TenantScope, userId: string, audit?: AuditContext) {
      if (audit)
        return db
          .batch([
            db
              .delete(appMemberships)
              .where(
                and(
                  eq(appMemberships.appId, scope.appId),
                  eq(appMemberships.userId, userId),
                  canDeleteMember(scope),
                ),
              )
              .returning(),
            auditInsert(db, scope, {
              ...audit,
              action: "app_members_remove",
              resourceType: "app_membership",
              resourceId: userId,
            }),
          ])
          .then(([rows]) => rows.length);
      return table.remove(scope, and(eq(appMemberships.userId, userId), canDeleteMember(scope)));
    },

    deleteAppMemberships(scope: TenantScope) {
      return table.remove(scope);
    },
  };
}

function canChangeOwnerRole(scope: TenantScope, nextRole: string) {
  return sql`(${appMemberships.role} <> 'owner' OR ${nextRole} = 'owner' OR ${ownerCount(scope)} > 1)`;
}

function canDeleteMember(scope: TenantScope) {
  return sql`(${appMemberships.role} <> 'owner' OR ${ownerCount(scope)} > 1)`;
}

function ownerCount(scope: TenantScope) {
  return sql`(SELECT COUNT(*) FROM ${appMemberships} WHERE ${appMemberships.appId} = ${scope.appId} AND ${appMemberships.role} = 'owner')`;
}
