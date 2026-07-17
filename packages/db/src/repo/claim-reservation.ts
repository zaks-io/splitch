import type { ClaimIdentityHashes } from "./claim-types";

export function makeClaimReservationRepo(d1: D1Database) {
  return {
    async completedClaim(input: ClaimIdentityHashes & { keyHash: string; now: string }) {
      return (
        (await d1
          .prepare(
            `SELECT 1 FROM claim_idempotency
             WHERE key_hash = ? AND provisional_user_hash = ? AND email_hash = ?
               AND organization_hash = ? AND app_hash = ? AND verified_user_hash = ?
               AND completed_at IS NOT NULL
               AND expires_at > ?`,
          )
          .bind(
            input.keyHash,
            input.provisionalUserHash,
            input.emailHash,
            input.organizationHash,
            input.appHash,
            input.verifiedUserHash,
            input.now,
          )
          .first()) !== null
      );
    },

    async reserveClaim(
      input: ClaimIdentityHashes & {
        keyHash: string;
        verificationId: string;
        expiresAt: string;
      },
    ) {
      const result = await d1
        .prepare(
          `INSERT INTO claim_idempotency
             (key_hash, verification_id, provisional_user_hash, email_hash,
              organization_hash, app_hash, verified_user_hash, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          input.keyHash,
          input.verificationId,
          input.provisionalUserHash,
          input.emailHash,
          input.organizationHash,
          input.appHash,
          input.verifiedUserHash,
          input.expiresAt,
        )
        .run();
      return result.meta.changes === 1;
    },

    async releaseClaimReservation(input: ClaimIdentityHashes & { keyHash: string }) {
      await d1
        .prepare(
          `DELETE FROM claim_idempotency
             WHERE key_hash = ? AND provisional_user_hash = ? AND email_hash = ?
               AND organization_hash = ? AND app_hash = ? AND verified_user_hash = ?
               AND completed_at IS NULL`,
        )
        .bind(
          input.keyHash,
          input.provisionalUserHash,
          input.emailHash,
          input.organizationHash,
          input.appHash,
          input.verifiedUserHash,
        )
        .run();
    },
  };
}
