import type { personalAccessTokenRotations } from "../schema/personal-access-token-step-up";
import type { PersonalAccessTokenPatch, PersonalAccessTokenRow } from "./personal-access-tokens";

export interface PersonalAccessTokenStepUpUse {
  jti: string;
  consumedAt: string;
  expiresAt: string;
}

export type PersonalAccessTokenRotation = typeof personalAccessTokenRotations.$inferSelect;

export class PersonalAccessTokenClaimRefused extends Error {
  constructor() {
    super("personal access token authorization claim refused");
  }
}

const TOKEN_COLUMNS = `id, user_id AS userId, name, token_hash AS tokenHash, grants,
  expires_at AS expiresAt, created_at AS createdAt, last_rotated_at AS lastRotatedAt, revoked_at AS revokedAt`;
const ROTATION_COLUMNS = `id, user_id AS userId, token_id AS tokenId, previous_hash AS previousHash,
  candidate_hash AS candidateHash, operation_hash AS operationHash, step_up_jti AS stepUpJti,
  phase, claimed_at AS claimedAt, updated_at AS updatedAt`;
const NO_ROTATION = `NOT EXISTS (SELECT 1 FROM personal_access_token_rotations r
  WHERE r.token_id = personal_access_tokens.id AND r.phase NOT IN ('completed', 'retired'))`;

// The full authority snapshot prevents a stale cleanup decision from overwriting
// a concurrent change. SQLite IS compares nullable expiries without a default.
function snapshot(current: PersonalAccessTokenRow) {
  return {
    sql: `id = ? AND user_id = ? AND token_hash = ? AND grants = ? AND expires_at IS ? AND revoked_at IS NULL`,
    values: [current.id, current.userId, current.tokenHash, current.grants, current.expiresAt],
  };
}

function consume(
  d1: D1Database,
  userId: string,
  use: PersonalAccessTokenStepUpUse,
  guard?: ReturnType<typeof snapshot>,
) {
  return d1
    .prepare(`INSERT INTO personal_access_token_step_up_uses (jti, user_id, consumed_at, expires_at)
    SELECT ?, ?, ?, ? ${guard ? `FROM personal_access_tokens WHERE ${guard.sql} AND ${NO_ROTATION}` : ""}`)
    .bind(use.jti, userId, use.consumedAt, use.expiresAt, ...(guard?.values ?? []));
}

async function batch(d1: D1Database, statements: D1PreparedStatement[]) {
  try {
    return await d1.batch(statements);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: personal_access_token_"))
      throw new PersonalAccessTokenClaimRefused();
    throw error;
  }
}

export function makePersonalAccessTokenAuthorizationRepo(d1: D1Database) {
  return {
    async insertAuthorized(
      row: Omit<PersonalAccessTokenRow, "lastRotatedAt" | "revokedAt">,
      use?: PersonalAccessTokenStepUpUse,
    ): Promise<PersonalAccessTokenRow> {
      const statements = use ? [consume(d1, row.userId, use)] : [];
      statements.push(
        d1
          .prepare(`INSERT INTO personal_access_tokens (id,user_id,name,token_hash,grants,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?) RETURNING ${TOKEN_COLUMNS}`)
          .bind(
            row.id,
            row.userId,
            row.name,
            row.tokenHash,
            row.grants,
            row.expiresAt,
            row.createdAt,
          ),
      );
      const result = await batch(d1, statements);
      const inserted = result.at(-1)?.results[0] as PersonalAccessTokenRow | undefined;
      if (!inserted) throw new Error("db: authorized PAT insert returned no row");
      return inserted;
    },

    async updateAuthorized(
      current: PersonalAccessTokenRow,
      patch: PersonalAccessTokenPatch,
      use?: PersonalAccessTokenStepUpUse,
    ): Promise<PersonalAccessTokenRow | null> {
      const guard = snapshot(current);
      const statements = use ? [consume(d1, current.userId, use, guard)] : [];
      const fields = Object.entries({
        name: patch.name,
        grants: patch.grants,
        expires_at: patch.expiresAt,
      }).filter(([, value]) => value !== undefined);
      if (fields.length === 0) throw new Error("db: authorized PAT update requires a patch");
      statements.push(
        d1
          .prepare(`UPDATE personal_access_tokens SET ${fields.map(([column]) => `${column} = ?`).join(", ")}
        WHERE ${guard.sql} AND ${NO_ROTATION} RETURNING ${TOKEN_COLUMNS}`)
          .bind(...fields.map(([, value]) => value), ...guard.values),
      );
      const result = await batch(d1, statements);
      return (result.at(-1)?.results[0] as PersonalAccessTokenRow | undefined) ?? null;
    },

    async claimRotation(
      current: PersonalAccessTokenRow,
      claim: { id: string; candidateHash: string; operationHash: string; now: string },
      use?: PersonalAccessTokenStepUpUse,
    ): Promise<boolean> {
      const guard = snapshot(current);
      const statements = use ? [consume(d1, current.userId, use, guard)] : [];
      statements.push(
        d1
          .prepare(`INSERT INTO personal_access_token_rotations
        (id,user_id,token_id,previous_hash,candidate_hash,operation_hash,step_up_jti,phase,claimed_at,updated_at)
        SELECT ?, user_id, id, token_hash, ?, ?, ?, 'claimed', ?, ? FROM personal_access_tokens
        WHERE ${guard.sql} AND ${NO_ROTATION}`)
          .bind(
            claim.id,
            claim.candidateHash,
            claim.operationHash,
            use?.jti ?? null,
            claim.now,
            claim.now,
            ...guard.values,
          ),
      );
      const results = await batch(d1, statements);
      return results.at(-1)?.meta.changes === 1;
    },

    async advanceRotation(
      userId: string,
      id: string,
      from: PersonalAccessTokenRotation["phase"],
      to: PersonalAccessTokenRotation["phase"],
      now: string,
    ): Promise<boolean> {
      const result = await d1
        .prepare(`UPDATE personal_access_token_rotations SET phase = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND phase = ?`)
        .bind(to, now, id, userId, from)
        .run();
      return result.meta.changes === 1;
    },

    async swapRotation(
      userId: string,
      id: string,
      now: string,
    ): Promise<PersonalAccessTokenRow | null> {
      const results = await d1.batch([
        d1
          .prepare(`UPDATE personal_access_tokens SET token_hash = (SELECT candidate_hash FROM personal_access_token_rotations WHERE id = ?), last_rotated_at = ?
          WHERE user_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM personal_access_token_rotations r
          WHERE r.id = ? AND r.user_id = ? AND r.token_id = personal_access_tokens.id
          AND r.previous_hash = personal_access_tokens.token_hash AND r.phase = 'candidate_published') RETURNING ${TOKEN_COLUMNS}`)
          .bind(id, now, userId, id, userId),
        d1
          .prepare(`UPDATE personal_access_token_rotations SET phase = 'swapped', updated_at = ? WHERE id = ? AND user_id = ? AND phase = 'candidate_published'
          AND EXISTS (SELECT 1 FROM personal_access_tokens p WHERE p.id = token_id AND p.user_id = ? AND p.token_hash = candidate_hash AND p.revoked_at IS NULL)`)
          .bind(now, id, userId, userId),
      ]);
      return (results[0]?.results[0] as PersonalAccessTokenRow | undefined) ?? null;
    },

    async hasPendingRotation(userId: string, tokenId: string): Promise<boolean> {
      return (
        (await d1
          .prepare(
            `SELECT 1 FROM personal_access_token_rotations WHERE user_id = ? AND token_id = ? AND phase NOT IN ('completed','retired') LIMIT 1`,
          )
          .bind(userId, tokenId)
          .first()) !== null
      );
    },

    async pendingRotations(before: string, limit: number): Promise<PersonalAccessTokenRotation[]> {
      const rows = await d1
        .prepare(`SELECT ${ROTATION_COLUMNS} FROM personal_access_token_rotations
        WHERE phase NOT IN ('completed','retired') AND updated_at <= ? ORDER BY updated_at,id LIMIT ?`)
        .bind(before, Math.min(limit, 100))
        .all<PersonalAccessTokenRotation>();
      return rows.results;
    },

    async retireRotation(userId: string, id: string, now: string): Promise<void> {
      // Revoke first, atomically with taking recovery ownership. Even an in-flight
      // KV write from the original owner cannot make either secret usable again.
      await d1.batch([
        d1
          .prepare(
            `UPDATE personal_access_token_rotations SET phase = 'retiring', updated_at = ? WHERE user_id = ? AND id = ? AND phase NOT IN ('completed','retired')`,
          )
          .bind(now, userId, id),
        d1
          .prepare(`UPDATE personal_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND id IN
          (SELECT token_id FROM personal_access_token_rotations WHERE user_id = ? AND id = ? AND phase = 'retiring')`)
          .bind(now, userId, userId, id),
      ]);
    },

    purgeStepUpUses: (now: string, limit: number) => purgeStepUpUses(d1, now, limit),
  };
}

async function purgeStepUpUses(d1: D1Database, now: string, limit: number): Promise<number> {
  const cutoff = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
  const bounded = Math.min(Math.max(limit, 1), 100);
  // Terminal operations are removed first to preserve the consumption FK.
  await d1
    .prepare(`DELETE FROM personal_access_token_rotations WHERE id IN
        (SELECT id FROM personal_access_token_rotations WHERE phase IN ('completed','retired') AND updated_at < ? ORDER BY updated_at,id LIMIT ?)`)
    .bind(cutoff, bounded)
    .run();
  const result = await d1
    .prepare(`DELETE FROM personal_access_token_step_up_uses WHERE jti IN
        (SELECT jti FROM personal_access_token_step_up_uses u WHERE expires_at < ?
        AND NOT EXISTS (SELECT 1 FROM personal_access_token_rotations r WHERE r.step_up_jti = u.jti)
        ORDER BY expires_at,jti LIMIT ?)`)
    .bind(cutoff, bounded)
    .run();
  return result.meta.changes;
}
