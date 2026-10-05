import type { CloudflareDeliveryRow } from "./cloudflare-integrations";
import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";

export async function claimDueCloudflareDeliveries(
  d1: D1Database,
  now: string,
  leaseOwner: string,
  leaseExpiresAt: string,
  limit: number,
): Promise<CloudflareDeliveryRow[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Cloudflare delivery claim limit must be a positive integer");
  const [leased, claimed] = await d1.batch<CloudflareDeliveryRow>([
    d1
      .prepare(`UPDATE cloudflare_config_deliveries
        SET state = 'leased', lease_owner = ?, lease_expires_at = ?
        WHERE delivery_id IN (
          SELECT delivery.delivery_id FROM cloudflare_config_deliveries delivery
          JOIN cloudflare_installations installation
            ON installation.installation_id = delivery.installation_id
          WHERE installation.status = 'active'
            AND ((delivery.state = 'pending' AND delivery.next_attempt_at <= ?)
              OR (delivery.state = 'leased' AND delivery.lease_expires_at <= ?))
            AND NOT EXISTS (
              SELECT 1 FROM cloudflare_config_deliveries newer
              WHERE newer.installation_id = delivery.installation_id
                AND newer.environment_version > delivery.environment_version
                AND newer.state IN ('pending', 'leased')
            )
          ORDER BY delivery.next_attempt_at, delivery.delivery_id LIMIT ?
        ) RETURNING delivery_id AS deliveryId`)
      .bind(leaseOwner, leaseExpiresAt, now, now, limit),
    d1
      .prepare(`SELECT delivery.delivery_id AS deliveryId,
        delivery.installation_id AS installationId, delivery.app_id AS appId,
        delivery.environment_id AS environmentId, installation.endpoint AS endpoint,
        installation.secret_ciphertext AS secretCiphertext,
        installation.secret_key_version AS secretKeyVersion,
        delivery.environment_version AS environmentVersion,
        delivery.attempt_count AS attemptCount,
        installation.last_applied_version AS lastAppliedVersion,
        installation.created_at AS registeredAt
        FROM cloudflare_config_deliveries delivery JOIN cloudflare_installations installation
          ON installation.installation_id = delivery.installation_id
        WHERE delivery.state = 'leased' AND delivery.lease_owner = ?
          AND installation.status = 'active'
        ORDER BY delivery.next_attempt_at, delivery.delivery_id`)
      .bind(leaseOwner),
  ]);
  if (!leased || !claimed)
    throw new Error("Cloudflare delivery claim: D1 batch did not return both statement results");
  const updatedIds = new Set(leased.results.map((row) => row.deliveryId));
  return claimed.results.filter((row) => updatedIds.has(row.deliveryId));
}

export interface CloudflareDeliveryFinish {
  state: "delivered" | "pending" | "terminal";
  now: string;
  appliedVersion?: number;
  nextAttemptAt?: string;
  errorJson?: string;
}

/**
 * The `(installation, version)` unique index means a terminal delivery for the
 * current version blocks every new one until the Environment version moves.
 * Re-registration re-arms that row so a rerun of setup retries now.
 */
export async function retryTerminalCloudflareDelivery(
  d1: D1Database,
  scope: EnvScope,
  installationId: string,
  now: string,
): Promise<void> {
  assertMintedScope(scope);
  await d1
    .prepare(`UPDATE cloudflare_config_deliveries SET state = 'pending',
    attempt_count = 0, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL
    WHERE app_id = ? AND environment_id = ? AND installation_id = ? AND state = 'terminal'
    AND environment_version = (
      SELECT config_version FROM environments WHERE app_id = ? AND id = ?)
    AND EXISTS (SELECT 1 FROM cloudflare_installations
      WHERE installation_id = ? AND status = 'active')`)
    .bind(
      now,
      scope.appId,
      scope.environmentId,
      installationId,
      scope.appId,
      scope.environmentId,
      installationId,
    )
    .run();
}

export async function finishCloudflareDelivery(
  d1: D1Database,
  deliveryId: string,
  leaseOwner: string,
  input: CloudflareDeliveryFinish,
): Promise<void> {
  const delivered = input.state === "delivered";
  const successful = delivered ? 1 : 0;
  const appliedVersion = input.appliedVersion ?? 0;
  const errorJson = input.errorJson ?? null;
  await d1.batch([
    d1
      .prepare(`UPDATE cloudflare_installations SET
      last_applied_version = CASE WHEN ? THEN MAX(COALESCE(last_applied_version, 0), ?) ELSE last_applied_version END,
      last_applied_at = CASE WHEN ? THEN ? ELSE last_applied_at END,
      latest_delivery_error_json = CASE
        WHEN ? THEN NULL
        WHEN (SELECT environment_version FROM cloudflare_config_deliveries WHERE delivery_id = ?)
          >= COALESCE(last_applied_version, 0) THEN ?
        ELSE latest_delivery_error_json
      END,
      updated_at = ?
      WHERE installation_id = (SELECT installation_id FROM cloudflare_config_deliveries WHERE delivery_id = ?)
      AND EXISTS (SELECT 1 FROM cloudflare_config_deliveries
        WHERE delivery_id = ? AND lease_owner = ?)`)
      .bind(
        successful,
        appliedVersion,
        successful,
        input.now,
        successful,
        deliveryId,
        errorJson,
        input.now,
        deliveryId,
        deliveryId,
        leaseOwner,
      ),
    d1
      .prepare(`UPDATE cloudflare_config_deliveries SET state = 'suppressed'
      WHERE installation_id = (SELECT installation_id FROM cloudflare_config_deliveries WHERE delivery_id = ?)
      AND state = 'pending' AND environment_version <= ?
      AND EXISTS (SELECT 1 FROM cloudflare_config_deliveries
        WHERE delivery_id = ? AND lease_owner = ?)`)
      .bind(deliveryId, delivered ? appliedVersion : -1, deliveryId, leaseOwner),
    d1
      .prepare(`UPDATE cloudflare_config_deliveries SET state = ?,
      attempt_count = attempt_count + 1, next_attempt_at = COALESCE(?, next_attempt_at),
      last_error_json = ?, delivered_at = ?, lease_owner = NULL, lease_expires_at = NULL
      WHERE delivery_id = ? AND lease_owner = ?`)
      .bind(
        input.state,
        input.nextAttemptAt ?? null,
        errorJson,
        delivered ? input.now : null,
        deliveryId,
        leaseOwner,
      ),
  ]);
}
