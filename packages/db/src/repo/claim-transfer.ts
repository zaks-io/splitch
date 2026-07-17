export interface CompleteClaimInput {
  provisionalUserHash: string;
  emailHash: string;
  organizationHash: string;
  appHash: string;
  verifiedUserHash: string;
  verificationId: string;
  consentAttemptId: string | null;
  keyHash: string;
  provisionalUserId: string;
  verifiedUserId: string;
  orgId: string;
  appId: string;
  acquisitionToken: string;
  acquisitionKeyHash: string;
  now: string;
  expiresAt: string;
}

export async function completeClaim(d1: D1Database, input: CompleteClaimInput): Promise<boolean> {
  const consentGuard = input.consentAttemptId
    ? `EXISTS (SELECT 1 FROM claim_consent_attempts
                WHERE id = ? AND verification_id = ? AND approved_at IS NOT NULL
                  AND consumed_at IS NULL AND expires_at > ?)`
    : "1 = 1";
  const verificationGuard = `EXISTS (SELECT 1 FROM claim_verifications
    WHERE id = ? AND provisional_user_hash = ? AND email_hash = ?
      AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > ?)`;
  const guardValues = input.consentAttemptId
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
  const invariants = `${verificationGuard} AND ${consentGuard}`;
  const membershipGuard = `EXISTS (SELECT 1 FROM org_memberships
    WHERE org_id = ? AND user_id = ?)
    AND EXISTS (SELECT 1 FROM app_memberships
      WHERE app_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM apps
          WHERE apps.id = app_memberships.app_id AND apps.organization_id = ?))`;
  const membershipValues = [
    input.orgId,
    input.provisionalUserId,
    input.appId,
    input.provisionalUserId,
    input.orgId,
  ];
  const acquisitionInvariants = `${invariants} AND ${membershipGuard}`;
  const acquiredGuard = `EXISTS (SELECT 1 FROM organizations
    WHERE id = ? AND is_provisional = 0 AND claim_acquisition_token = ?)
    AND EXISTS (SELECT 1 FROM claim_verifications
      WHERE id = ? AND provisional_user_hash = ? AND email_hash = ?
        AND verified_at IS NOT NULL AND expires_at > ?)
    AND ${
      input.consentAttemptId
        ? `EXISTS (SELECT 1 FROM claim_consent_attempts
      WHERE id = ? AND verification_id = ? AND approved_at IS NOT NULL)`
        : "1 = 1"
    }`;
  const acquiredValues = input.consentAttemptId
    ? [
        input.orgId,
        input.acquisitionToken,
        input.verificationId,
        input.provisionalUserHash,
        input.emailHash,
        input.now,
        input.consentAttemptId,
        input.verificationId,
      ]
    : [
        input.orgId,
        input.acquisitionToken,
        input.verificationId,
        input.provisionalUserHash,
        input.emailHash,
        input.now,
      ];
  const statements = [
    d1
      .prepare(
        `UPDATE organizations SET is_provisional = 0, demo_expires_at = NULL,
            claim_acquisition_token = ?, claim_acquisition_key_hash = ?, updated_at = ?
           WHERE id = ? AND is_provisional = 1 AND claim_acquisition_token IS NULL AND ${acquisitionInvariants}`,
      )
      .bind(
        input.acquisitionToken,
        input.acquisitionKeyHash,
        input.now,
        input.orgId,
        ...guardValues,
        ...membershipValues,
      ),
    d1
      .prepare(`DELETE FROM org_memberships WHERE user_id = ? AND org_id = ?
        AND EXISTS (SELECT 1 FROM org_memberships AS target WHERE target.org_id = org_memberships.org_id AND target.user_id = ?)
        AND ${acquiredGuard}`)
      .bind(input.provisionalUserId, input.orgId, input.verifiedUserId, ...acquiredValues),
    d1
      .prepare(
        `UPDATE org_memberships SET user_id = ? WHERE user_id = ? AND org_id = ? AND ${acquiredGuard}`,
      )
      .bind(input.verifiedUserId, input.provisionalUserId, input.orgId, ...acquiredValues),
    d1
      .prepare(`DELETE FROM app_memberships WHERE user_id = ? AND app_id IN (SELECT id FROM apps WHERE organization_id = ?)
        AND EXISTS (SELECT 1 FROM app_memberships AS target WHERE target.app_id = app_memberships.app_id AND target.user_id = ?)
        AND ${acquiredGuard}`)
      .bind(input.provisionalUserId, input.orgId, input.verifiedUserId, ...acquiredValues),
    d1
      .prepare(
        `UPDATE app_memberships SET user_id = ? WHERE user_id = ? AND app_id IN (SELECT id FROM apps WHERE organization_id = ?) AND ${acquiredGuard}`,
      )
      .bind(input.verifiedUserId, input.provisionalUserId, input.orgId, ...acquiredValues),
    d1
      .prepare(
        `UPDATE claim_verifications SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND ${acquiredGuard}`,
      )
      .bind(input.now, input.verificationId, ...acquiredValues),
    ...(input.consentAttemptId
      ? [
          d1
            .prepare(
              `UPDATE claim_consent_attempts SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND ${acquiredGuard}`,
            )
            .bind(input.now, input.consentAttemptId, ...acquiredValues),
        ]
      : []),
    d1
      .prepare(
        `INSERT INTO claim_idempotency
           (key_hash, verification_id, provisional_user_hash, email_hash,
            organization_hash, app_hash, verified_user_hash, completed_at, expires_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${acquiredGuard}`,
      )
      .bind(
        input.keyHash,
        input.verificationId,
        input.provisionalUserHash,
        input.emailHash,
        input.organizationHash,
        input.appHash,
        input.verifiedUserHash,
        input.now,
        input.expiresAt,
        ...acquiredValues,
      ),
    d1
      .prepare(
        `UPDATE organizations SET claim_acquisition_key_hash = NULL
           WHERE id = ? AND claim_acquisition_token = ?`,
      )
      .bind(input.orgId, input.acquisitionToken),
  ];
  const results = await d1.batch(statements);
  return results[0]?.meta.changes === 1;
}
