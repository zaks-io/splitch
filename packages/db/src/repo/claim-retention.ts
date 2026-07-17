interface ClaimIdempotencyKey {
  key_hash: string;
  provisional_user_hash: string;
  email_hash: string;
  organization_hash: string;
  app_hash: string;
  verified_user_hash: string;
}

export async function purgeExpiredClaimArtifacts(
  d1: D1Database,
  input: { now: string; limit: number },
) {
  const limit = Math.min(Math.max(input.limit, 1), 100);
  const idempotency = await d1
    .prepare(
      `SELECT key_hash, provisional_user_hash, email_hash,
              organization_hash, app_hash, verified_user_hash
         FROM claim_idempotency
         WHERE expires_at <= ?
         ORDER BY expires_at ASC LIMIT ?`,
    )
    .bind(input.now, limit)
    .all<ClaimIdempotencyKey>();
  const deletedIdempotency = idempotency.results.length
    ? await d1.batch(
        idempotency.results.map((row) =>
          d1
            .prepare(
              `DELETE FROM claim_idempotency
               WHERE key_hash = ? AND provisional_user_hash = ? AND email_hash = ?
                 AND organization_hash = ? AND app_hash = ? AND verified_user_hash = ?`,
            )
            .bind(
              row.key_hash,
              row.provisional_user_hash,
              row.email_hash,
              row.organization_hash,
              row.app_hash,
              row.verified_user_hash,
            ),
        ),
      )
    : [];
  const verifications = await d1
    .prepare(
      `SELECT id FROM claim_verifications
         WHERE expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM claim_idempotency WHERE verification_id = claim_verifications.id
           )
         ORDER BY expires_at ASC LIMIT ?`,
    )
    .bind(input.now, limit)
    .all<{ id: string }>();
  let consentAttempts = 0;
  let deletedVerifications = 0;
  for (const verification of verifications.results) {
    const results = await d1.batch([
      d1
        .prepare(`DELETE FROM claim_consent_attempts WHERE verification_id = ?`)
        .bind(verification.id),
      d1
        .prepare(`DELETE FROM claim_verifications WHERE id = ? AND expires_at <= ?`)
        .bind(verification.id, input.now),
    ]);
    consentAttempts += results[0]?.meta.changes ?? 0;
    deletedVerifications += results[1]?.meta.changes ?? 0;
  }
  return {
    idempotency: deletedIdempotency.reduce((count, result) => count + result.meta.changes, 0),
    consentAttempts,
    verifications: deletedVerifications,
  };
}
