import type { ClaimIdentityHashes } from "./claim-types";

export function makeClaimReservationRepo(d1: D1Database) {
  return {
    async getClaimReservation(input: ClaimIdentityHashes & { keyHash: string }) {
      const row = await d1
        .prepare(
          `SELECT verification_id, selected_resource, completed_at, provider_confirmation_started_at, expires_at
             FROM claim_idempotency
             WHERE key_hash = ? AND provisional_user_hash = ? AND email_hash = ?
               AND organization_hash = ? AND app_hash = ? AND verified_user_hash = ?`,
        )
        .bind(
          input.keyHash,
          input.provisionalUserHash,
          input.emailHash,
          input.organizationHash,
          input.appHash,
          input.verifiedUserHash,
        )
        .first<{
          verification_id: string;
          selected_resource: string | null;
          completed_at: string | null;
          provider_confirmation_started_at: string | null;
          expires_at: string;
        }>();
      return row
        ? {
            verificationId: row.verification_id,
            selectedResource: row.selected_resource,
            completedAt: row.completed_at,
            providerConfirmationStartedAt: row.provider_confirmation_started_at,
            expiresAt: row.expires_at,
          }
        : null;
    },

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
        selectedResource?: string | null;
        expiresAt: string;
      },
    ) {
      const result = await d1
        .prepare(
          `INSERT INTO claim_idempotency
             (key_hash, verification_id, provisional_user_hash, email_hash,
              organization_hash, app_hash, verified_user_hash, selected_resource, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          input.selectedResource ?? null,
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

    async markProviderConfirmationStarted(
      input: ClaimIdentityHashes & { keyHash: string; now: string },
    ) {
      const result = await d1
        .prepare(
          `UPDATE claim_idempotency SET provider_confirmation_started_at = ?
             WHERE key_hash = ? AND provisional_user_hash = ? AND email_hash = ?
               AND organization_hash = ? AND app_hash = ? AND verified_user_hash = ?
               AND completed_at IS NULL AND provider_confirmation_started_at IS NULL`,
        )
        .bind(
          input.now,
          input.keyHash,
          input.provisionalUserHash,
          input.emailHash,
          input.organizationHash,
          input.appHash,
          input.verifiedUserHash,
        )
        .run();
      return result.meta.changes === 1;
    },
  };
}
