import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { personalAccessTokens } from "../schema/index";
import type { Db } from "./client";

export type PersonalAccessTokenRow = typeof personalAccessTokens.$inferSelect;

export interface PersonalAccessTokenPatch {
  name?: string;
  grants?: string;
  expiresAt?: string | null;
}

/**
 * Personal Access Token rows. Every read and write is keyed by the owning user,
 * so one user can never address another user's token by id. The one id-only
 * read (`getById`) serves the MCP door, whose caller compares the row's owner
 * with the signed delegation subject before trusting it.
 *
 * Mutations only touch ACTIVE (unrevoked) rows; a zero-row result is returned
 * as null so the caller fails loud instead of reporting a write that never
 * reached D1.
 */
export function makePersonalAccessTokenRepo(db: Db) {
  const active = (userId: string, id: string) =>
    and(
      eq(personalAccessTokens.userId, userId),
      eq(personalAccessTokens.id, id),
      isNull(personalAccessTokens.revokedAt),
    );

  return {
    async insert(
      values: typeof personalAccessTokens.$inferInsert,
    ): Promise<PersonalAccessTokenRow> {
      const rows = await db.insert(personalAccessTokens).values(values).returning();
      const row = rows[0];
      if (!row) throw new Error("db: personal access token insert returned no row");
      return row;
    },

    async listForUser(
      userId: string,
      options: { limit: number },
    ): Promise<PersonalAccessTokenRow[]> {
      return (
        db
          .select()
          .from(personalAccessTokens)
          .where(eq(personalAccessTokens.userId, userId))
          // Active tokens first, so a long revoked history never pushes a live
          // token past the read limit.
          .orderBy(
            sql`${personalAccessTokens.revokedAt} IS NULL DESC`,
            desc(personalAccessTokens.createdAt),
            desc(personalAccessTokens.id),
          )
          .limit(options.limit)
      );
    },

    async listActiveForUser(userId: string): Promise<PersonalAccessTokenRow[]> {
      return db
        .select()
        .from(personalAccessTokens)
        .where(
          and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)),
        );
    },

    async getForUser(userId: string, id: string): Promise<PersonalAccessTokenRow | null> {
      const rows = await db
        .select()
        .from(personalAccessTokens)
        .where(and(eq(personalAccessTokens.userId, userId), eq(personalAccessTokens.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },

    async getById(id: string): Promise<PersonalAccessTokenRow | null> {
      const rows = await db
        .select()
        .from(personalAccessTokens)
        .where(eq(personalAccessTokens.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async update(
      userId: string,
      id: string,
      patch: PersonalAccessTokenPatch,
    ): Promise<PersonalAccessTokenRow | null> {
      const rows = await db
        .update(personalAccessTokens)
        .set(patch)
        .where(active(userId, id))
        .returning();
      return rows[0] ?? null;
    },

    /** Swap the hash only if it is still the one the caller read (no lost rotation). */
    async rotate(
      userId: string,
      id: string,
      values: { previousHash: string; tokenHash: string; rotatedAt: string },
    ): Promise<PersonalAccessTokenRow | null> {
      const rows = await db
        .update(personalAccessTokens)
        .set({ tokenHash: values.tokenHash, lastRotatedAt: values.rotatedAt })
        .where(and(active(userId, id), eq(personalAccessTokens.tokenHash, values.previousHash)))
        .returning();
      return rows[0] ?? null;
    },

    async revoke(
      userId: string,
      id: string,
      revokedAt: string,
    ): Promise<PersonalAccessTokenRow | null> {
      const rows = await db
        .update(personalAccessTokens)
        .set({ revokedAt })
        .where(active(userId, id))
        .returning();
      return rows[0] ?? null;
    },

    async revokeAllForUser(userId: string, revokedAt: string): Promise<PersonalAccessTokenRow[]> {
      return db
        .update(personalAccessTokens)
        .set({ revokedAt })
        .where(and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)))
        .returning();
    },
  };
}
