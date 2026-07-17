export interface ClaimHashes {
  provisionalUserHash: string;
  emailHash: string;
}

export interface ClaimVerification extends ClaimHashes {
  id: string;
  expiresAt: string;
  attempts: number;
  verifiedAt: string | null;
  consumedAt: string | null;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: claim writes must stay visibly within one D1 repository transaction seam.
export function makeClaimStateRepo(d1: D1Database) {
  return {
    async createVerification(input: ClaimHashes & { id: string; expiresAt: string; now: string }) {
      await d1
        .prepare(
          `INSERT INTO claim_verifications
             (id, provisional_user_hash, email_hash, expires_at, attempts, created_at)
           VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .bind(input.id, input.provisionalUserHash, input.emailHash, input.expiresAt, input.now)
        .run();
    },

    async getVerification(id: string): Promise<ClaimVerification | null> {
      const row = await d1
        .prepare(
          `SELECT id, provisional_user_hash, email_hash, expires_at, attempts, verified_at, consumed_at
             FROM claim_verifications WHERE id = ?`,
        )
        .bind(id)
        .first<Record<string, unknown>>();
      return row ? asVerification(row) : null;
    },

    async getLatestVerification(input: ClaimHashes): Promise<ClaimVerification | null> {
      const row = await d1
        .prepare(
          `SELECT id, provisional_user_hash, email_hash, expires_at, attempts, verified_at, consumed_at
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
          `UPDATE claim_consent_attempts SET approved_at = COALESCE(approved_at, ?)
             WHERE id = ? AND existing_user_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
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

    async completedClaim(input: ClaimHashes & { keyHash: string; now: string }) {
      return (
        (await d1
          .prepare(
            `SELECT 1 FROM claim_idempotency
             WHERE key_hash = ? AND provisional_user_hash = ? AND email_hash = ? AND expires_at > ?`,
          )
          .bind(input.keyHash, input.provisionalUserHash, input.emailHash, input.now)
          .first()) !== null
      );
    },

    async completeClaim(
      input: ClaimHashes & {
        verificationId: string;
        consentAttemptId: string | null;
        keyHash: string;
        provisionalUserId: string;
        verifiedUserId: string;
        orgId: string;
        now: string;
        expiresAt: string;
      },
    ) {
      const consentGuard = input.consentAttemptId
        ? `EXISTS (SELECT 1 FROM claim_consent_attempts
                    WHERE id = ? AND verification_id = ? AND approved_at IS NOT NULL
                      AND consumed_at IS NULL AND expires_at > ?)`
        : "1 = 1";
      const guard = `EXISTS (SELECT 1 FROM claim_verifications
        WHERE id = ? AND provisional_user_hash = ? AND email_hash = ?
          AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > ?)
        AND ${consentGuard}`;
      const guardValues = () =>
        input.consentAttemptId
          ? [
              input.verificationId,
              input.provisionalUserHash,
              input.emailHash,
              input.now,
              input.consentAttemptId,
              input.verificationId,
              input.now,
            ]
          : [input.verificationId, input.provisionalUserHash, input.emailHash, input.now];
      const statements = [
        d1
          .prepare(`DELETE FROM org_memberships WHERE user_id = ? AND org_id = ?
            AND EXISTS (SELECT 1 FROM org_memberships AS target WHERE target.org_id = org_memberships.org_id AND target.user_id = ?)
            AND ${guard}`)
          .bind(input.provisionalUserId, input.orgId, input.verifiedUserId, ...guardValues()),
        d1
          .prepare(
            `UPDATE org_memberships SET user_id = ? WHERE user_id = ? AND org_id = ? AND ${guard}`,
          )
          .bind(input.verifiedUserId, input.provisionalUserId, input.orgId, ...guardValues()),
        d1
          .prepare(`DELETE FROM app_memberships WHERE user_id = ? AND app_id IN (SELECT id FROM apps WHERE organization_id = ?)
            AND EXISTS (SELECT 1 FROM app_memberships AS target WHERE target.app_id = app_memberships.app_id AND target.user_id = ?)
            AND ${guard}`)
          .bind(input.provisionalUserId, input.orgId, input.verifiedUserId, ...guardValues()),
        d1
          .prepare(
            `UPDATE app_memberships SET user_id = ? WHERE user_id = ? AND app_id IN (SELECT id FROM apps WHERE organization_id = ?) AND ${guard}`,
          )
          .bind(input.verifiedUserId, input.provisionalUserId, input.orgId, ...guardValues()),
        d1
          .prepare(
            `UPDATE organizations SET is_provisional = 0, demo_expires_at = NULL, updated_at = ? WHERE id = ? AND is_provisional = 1 AND ${guard}`,
          )
          .bind(input.now, input.orgId, ...guardValues()),
        d1
          .prepare(
            `UPDATE claim_verifications SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND ${guard}`,
          )
          .bind(input.now, input.verificationId, ...guardValues()),
        ...(input.consentAttemptId
          ? [
              d1
                .prepare(
                  `UPDATE claim_consent_attempts SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`,
                )
                .bind(input.now, input.consentAttemptId),
            ]
          : []),
        d1
          .prepare(
            `INSERT INTO claim_idempotency
               (key_hash, verification_id, provisional_user_hash, email_hash, completed_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.keyHash,
            input.verificationId,
            input.provisionalUserHash,
            input.emailHash,
            input.now,
            input.expiresAt,
          ),
      ];
      const results = await d1.batch(statements);
      const orgResult = results[4];
      return orgResult?.meta.changes === 1;
    },
  };
}

function asVerification(row: Record<string, unknown>): ClaimVerification {
  return {
    id: requiredString(row.id),
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
