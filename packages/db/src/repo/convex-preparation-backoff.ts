export interface ConvexPreparationFailure {
  secretCiphertext: string;
  secretKeyVersion: string;
  now: string;
  retryAt: string;
  errorJson: string;
}

export async function deferConvexPreparationFailure(
  d1: D1Database,
  installationId: string,
  leaseOwner: string,
  input: ConvexPreparationFailure,
): Promise<void> {
  // Compare the claimed secret so an old worker cannot back off a repaired installation.
  await d1.batch([
    d1
      .prepare(`UPDATE convex_installations
      SET preparation_retry_at = ?, latest_delivery_error_json = ?, updated_at = ?
      WHERE installation_id = ? AND status = 'active'
        AND secret_ciphertext = ? AND secret_key_version = ?
        AND EXISTS (SELECT 1 FROM config_webhook_deliveries
          WHERE installation_id = ? AND state = 'leased' AND lease_owner = ?)`)
      .bind(
        input.retryAt,
        input.errorJson,
        input.now,
        installationId,
        input.secretCiphertext,
        input.secretKeyVersion,
        installationId,
        leaseOwner,
      ),
    d1
      .prepare(`UPDATE config_webhook_deliveries
      SET state = 'pending', next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
        attempt_count = attempt_count + CASE WHEN EXISTS (
          SELECT 1 FROM convex_installations WHERE installation_id = ?
            AND secret_ciphertext = ? AND secret_key_version = ?
        ) THEN 1 ELSE 0 END,
        last_error_json = CASE WHEN EXISTS (
          SELECT 1 FROM convex_installations WHERE installation_id = ?
            AND secret_ciphertext = ? AND secret_key_version = ?
        ) THEN ? ELSE last_error_json END
      WHERE installation_id = ? AND state = 'leased' AND lease_owner = ?
        AND EXISTS (SELECT 1 FROM convex_installations
          WHERE installation_id = ? AND status = 'active')`)
      .bind(
        input.now,
        installationId,
        input.secretCiphertext,
        input.secretKeyVersion,
        installationId,
        input.secretCiphertext,
        input.secretKeyVersion,
        input.errorJson,
        installationId,
        leaseOwner,
        installationId,
      ),
  ]);
}
