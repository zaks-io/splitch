import { makeClaimReservationRepo } from "./claim-reservation";
import { purgeExpiredClaimArtifacts } from "./claim-retention";
import { type CompleteClaimInput, completeClaim } from "./claim-transfer";
import type { ClaimHashes, ClaimVerification } from "./claim-types";

export type { ClaimHashes, ClaimVerification } from "./claim-types";

export function makeClaimStateRepo(d1: D1Database) {
  const reservations = makeClaimReservationRepo(d1);
  return {
    async createVerification(
      input: ClaimHashes & {
        id: string;
        selectedResource?: string;
        expiresAt: string;
        now: string;
      },
    ) {
      await d1
        .prepare(
          `INSERT INTO claim_verifications
             (id, provisional_user_hash, email_hash, selected_resource, expires_at, attempts, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .bind(
          input.id,
          input.provisionalUserHash,
          input.emailHash,
          input.selectedResource ?? null,
          input.expiresAt,
          input.now,
        )
        .run();
    },

    async getVerification(id: string): Promise<ClaimVerification | null> {
      const row = await d1
        .prepare(
          `SELECT id, provisional_user_hash, email_hash, selected_resource, expires_at, attempts, verified_at, consumed_at
             FROM claim_verifications WHERE id = ?`,
        )
        .bind(id)
        .first<Record<string, unknown>>();
      return row ? asVerification(row) : null;
    },

    async getLatestVerification(input: ClaimHashes): Promise<ClaimVerification | null> {
      const row = await d1
        .prepare(
          `SELECT id, provisional_user_hash, email_hash, selected_resource, expires_at, attempts, verified_at, consumed_at
             FROM claim_verifications WHERE provisional_user_hash = ? AND email_hash = ?
             ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(input.provisionalUserHash, input.emailHash)
        .first<Record<string, unknown>>();
      return row ? asVerification(row) : null;
    },

    async incrementAttempt(input: ClaimHashes & { id: string; now: string; maxAttempts: number }) {
      const result = await d1
        .prepare(
          `UPDATE claim_verifications SET attempts = attempts + 1
             WHERE id = ? AND provisional_user_hash = ? AND email_hash = ?
               AND consumed_at IS NULL AND expires_at > ? AND attempts < ?`,
        )
        .bind(input.id, input.provisionalUserHash, input.emailHash, input.now, input.maxAttempts)
        .run();
      return result.meta.changes === 1;
    },

    async markVerified(input: ClaimHashes & { id: string; now: string }) {
      const result = await d1
        .prepare(
          `UPDATE claim_verifications SET verified_at = COALESCE(verified_at, ?)
             WHERE id = ? AND provisional_user_hash = ? AND email_hash = ?
               AND consumed_at IS NULL AND expires_at > ?`,
        )
        .bind(input.now, input.id, input.provisionalUserHash, input.emailHash, input.now)
        .run();
      return result.meta.changes === 1;
    },

    async markVerifiedFromConsent(
      input: ClaimHashes & { id: string; consentAttemptId: string; now: string },
    ) {
      const result = await d1
        .prepare(
          `UPDATE claim_verifications SET verified_at = ?
             WHERE id = ? AND provisional_user_hash = ? AND email_hash = ?
               AND verified_at IS NULL AND consumed_at IS NULL AND expires_at > ?
               AND EXISTS (SELECT 1 FROM claim_consent_attempts
                 WHERE id = ? AND verification_id = ? AND approved_at IS NOT NULL
                   AND consumed_at IS NULL AND expires_at > ?)`,
        )
        .bind(
          input.now,
          input.id,
          input.provisionalUserHash,
          input.emailHash,
          input.now,
          input.consentAttemptId,
          input.id,
          input.now,
        )
        .run();
      return result.meta.changes === 1;
    },

    async createConsentAttempt(input: {
      id: string;
      verificationId: string;
      existingUserHash: string;
      expiresAt: string;
      now: string;
    }) {
      await d1
        .prepare(
          `INSERT INTO claim_consent_attempts
             (id, verification_id, existing_user_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(input.id, input.verificationId, input.existingUserHash, input.expiresAt, input.now)
        .run();
    },

    async approveConsent(input: { id: string; existingUserHash: string; now: string }) {
      const result = await d1
        .prepare(
          `UPDATE claim_consent_attempts SET approved_at = ?
             WHERE id = ? AND existing_user_hash = ? AND approved_at IS NULL
               AND consumed_at IS NULL AND expires_at > ?`,
        )
        .bind(input.now, input.id, input.existingUserHash, input.now)
        .run();
      return result.meta.changes === 1;
    },

    async refuseConsent(input: { id: string; existingUserHash: string; now: string }) {
      const result = await d1
        .prepare(
          `UPDATE claim_consent_attempts SET consumed_at = ?
             WHERE id = ? AND existing_user_hash = ? AND approved_at IS NULL
               AND consumed_at IS NULL AND expires_at > ?`,
        )
        .bind(input.now, input.id, input.existingUserHash, input.now)
        .run();
      return result.meta.changes === 1;
    },

    async getApprovedConsent(input: {
      verificationId: string;
      existingUserHash: string;
      now: string;
    }) {
      const row = await d1
        .prepare(
          `SELECT id FROM claim_consent_attempts
             WHERE verification_id = ? AND existing_user_hash = ?
               AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at > ?
             ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(input.verificationId, input.existingUserHash, input.now)
        .first<{ id: string }>();
      return row?.id ?? null;
    },

    ...reservations,

    purgeExpiredClaimArtifacts(input: { now: string; limit: number }) {
      return purgeExpiredClaimArtifacts(d1, input);
    },

    completeClaim(d1Input: CompleteClaimInput) {
      return completeClaim(d1, d1Input);
    },
  };
}

function asVerification(row: Record<string, unknown>): ClaimVerification {
  return {
    id: requiredString(row.id),
    selectedResource: typeof row.selected_resource === "string" ? row.selected_resource : null,
    provisionalUserHash: requiredString(row.provisional_user_hash),
    emailHash: requiredString(row.email_hash),
    expiresAt: requiredString(row.expires_at),
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    verifiedAt: typeof row.verified_at === "string" ? row.verified_at : null,
    consumedAt: typeof row.consumed_at === "string" ? row.consumed_at : null,
  };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid claim workflow row");
  return value;
}
