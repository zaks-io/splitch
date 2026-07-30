import { and, eq, sql } from "drizzle-orm";
import { organizations, orgMemberships } from "../schema/index";
import type { Db } from "./client";

/**
 * Organization and membership writes.
 *
 * Split out of `identity.ts` so that file stays inside the repo file-size
 * guard; the owner-count predicates below are only ever used here.
 */
export function makeOrgMutations(db: Db) {
  return {
    async updateOrg(
      orgId: string,
      values: Partial<Pick<typeof organizations.$inferInsert, "name" | "plan" | "updatedAt">>,
    ): Promise<typeof organizations.$inferSelect | null> {
      const rows = await db
        .update(organizations)
        .set(values)
        .where(eq(organizations.id, orgId))
        .returning();
      return rows[0] ?? null;
    },

    async updateOrgMembershipRole(
      orgId: string,
      userId: string,
      role: string,
    ): Promise<typeof orgMemberships.$inferSelect | null> {
      const rows = await db
        .update(orgMemberships)
        .set({ role })
        .where(
          and(
            eq(orgMemberships.orgId, orgId),
            eq(orgMemberships.userId, userId),
            canChangeOwnerRole(orgId, role),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async deleteOrgMembership(orgId: string, userId: string): Promise<number> {
      const rows = await db
        .delete(orgMemberships)
        .where(
          and(
            eq(orgMemberships.orgId, orgId),
            eq(orgMemberships.userId, userId),
            canDeleteMember(orgId),
          ),
        )
        .returning();
      return rows.length;
    },
  };
}

function canChangeOwnerRole(orgId: string, nextRole: string) {
  return sql`(${orgMemberships.role} <> 'owner' OR ${nextRole} = 'owner' OR ${ownerCount(orgId)} > 1)`;
}

function canDeleteMember(orgId: string) {
  return sql`(${orgMemberships.role} <> 'owner' OR ${ownerCount(orgId)} > 1)`;
}

function ownerCount(orgId: string) {
  return sql`(SELECT COUNT(*) FROM ${orgMemberships} WHERE ${orgMemberships.orgId} = ${orgId} AND ${orgMemberships.role} = 'owner')`;
}
