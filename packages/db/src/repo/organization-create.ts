import { eq } from "drizzle-orm";
import { organizations } from "../schema/index";
import type { Db } from "./client";

/**
 * Atomic Organization + owner-membership create (SPL-171).
 *
 * These two rows are ONE fact. An Organization with no owner is unreachable —
 * every Org route authorizes through live membership, so an orphan row would be
 * invisible to its own creator and to everyone else, permanently. Splitting the
 * writes means a failure between them leaks exactly that. `d1.batch` is the
 * transaction boundary (D1 has no `transaction()`), so both statements commit or
 * neither does.
 *
 * Slug uniqueness is enforced by the `organizations_slug_unique` index, NOT by a
 * preceding read. A pre-check read is racy: two concurrent creates both see the
 * slug free and both proceed. Here the loser's INSERT violates the index, D1
 * rolls the whole batch back, and the caller gets a `slug_conflict` it can act
 * on. (SQLite reports that violation by COLUMN, not by index name — see
 * `rethrowUnlessSlugConflict`.)
 */

export type CreateOrganizationInput = {
  organization: typeof organizations.$inferInsert;
  ownerUserId: string;
  createdAt: string;
};

export type CreateOrganizationResult =
  | { ok: true; organization: typeof organizations.$inferSelect }
  | { ok: false; reason: "slug_conflict" };

export function makeCreateOrganization(db: Db, d1: D1Database) {
  return async function createOrganization(
    input: CreateOrganizationInput,
  ): Promise<CreateOrganizationResult> {
    const results = await runCreateBatch(d1, input).catch(rethrowUnlessSlugConflict);
    if (results === SLUG_CONFLICT) return { ok: false, reason: "slug_conflict" };

    const [orgRows, membershipRows] = results;
    if (orgRows.length !== 1 || membershipRows.length !== 1) {
      // The batch is transactional, so a partial result means the statements
      // disagree about what they wrote. Never hand back a half-built tenant.
      throw new Error("createOrganization: guarded D1 batch produced an inconsistent result");
    }

    const created = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, input.organization.id))
      .limit(1)
      .then((rows) => rows[0]);
    if (!created) {
      throw new Error("createOrganization: committed Organization could not be reloaded");
    }
    return { ok: true, organization: created };
  };
}

const SLUG_CONFLICT = Symbol("slug_conflict");

async function runCreateBatch(d1: D1Database, input: CreateOrganizationInput) {
  const org = input.organization;
  const batch = await d1.batch([
    d1
      .prepare(
        `INSERT INTO organizations (id, name, slug, plan, is_provisional, demo_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .bind(
        org.id,
        org.name,
        org.slug,
        org.plan ?? "free",
        org.isProvisional ? 1 : 0,
        org.demoExpiresAt ?? null,
        org.createdAt ?? input.createdAt,
        org.updatedAt ?? input.createdAt,
      ),
    d1
      .prepare(
        `INSERT INTO org_memberships (org_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)
         RETURNING org_id`,
      )
      .bind(org.id, input.ownerUserId, input.createdAt),
  ]);
  return [batch[0]?.results ?? [], batch[1]?.results ?? []] as const;
}

/**
 * A unique-index violation on the slug is the collision check, so it is an
 * expected outcome, not a fault. Every OTHER D1 error still throws: a swallowed
 * write failure would return a success the caller cannot verify.
 *
 * Matching is on the whole SQLite constraint string, not on the column name
 * alone. `NOT NULL constraint failed: organizations.slug` also names that column,
 * and reading it as a collision would answer a broken write with "choose a
 * different slug" — advice that can never succeed. Nor does SQLite name the
 * INDEX here; it reports the column, so matching `organizations_slug_unique`
 * would never fire at all.
 */
const SLUG_UNIQUE_VIOLATION = "UNIQUE constraint failed: organizations.slug";

function rethrowUnlessSlugConflict(error: unknown): typeof SLUG_CONFLICT {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(SLUG_UNIQUE_VIOLATION)) {
    return SLUG_CONFLICT;
  }
  throw error;
}
