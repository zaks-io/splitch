import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";

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
