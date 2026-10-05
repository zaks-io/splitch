import type { ConfigWebhookDeliveryRow } from "./convex-integrations";

export async function claimDueConvexDeliveries(
  d1: D1Database,
  now: string,
  leaseOwner: string,
  leaseExpiresAt: string,
  limit: number,
): Promise<ConfigWebhookDeliveryRow[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Convex delivery claim limit must be a positive integer");
  const [leased, claimed] = await d1.batch<ConfigWebhookDeliveryRow>([
    d1
      .prepare(`UPDATE config_webhook_deliveries
        SET state = 'leased', lease_owner = ?, lease_expires_at = ?
        WHERE delivery_id IN (
          SELECT delivery.delivery_id FROM config_webhook_deliveries delivery
          JOIN convex_installations installation
            ON installation.installation_id = delivery.installation_id
          WHERE installation.status = 'active'
            AND ((delivery.state = 'pending' AND delivery.next_attempt_at <= ?)
              OR (delivery.state = 'leased' AND delivery.lease_expires_at <= ?))
          ORDER BY delivery.next_attempt_at, delivery.delivery_id LIMIT ?
        ) RETURNING delivery_id AS deliveryId`)
      .bind(leaseOwner, leaseExpiresAt, now, now, limit),
    d1
      .prepare(`SELECT delivery.delivery_id AS deliveryId, delivery.installation_id AS installationId,
        installation.callback_url AS callbackUrl, installation.secret_ciphertext AS secretCiphertext,
        installation.secret_key_version AS secretKeyVersion, delivery.environment_version AS environmentVersion,
        delivery.body_json AS bodyJson, delivery.attempt_count AS attemptCount
        FROM config_webhook_deliveries delivery JOIN convex_installations installation
          ON installation.installation_id = delivery.installation_id
        WHERE delivery.state = 'leased' AND delivery.lease_owner = ?
          AND installation.status = 'active'
        ORDER BY delivery.next_attempt_at, delivery.delivery_id`)
      .bind(leaseOwner),
  ]);
  if (!leased || !claimed)
    throw new Error("Convex delivery claim: D1 batch did not return both statement results");
  const updatedIds = new Set(leased.results.map((row) => row.deliveryId));
  return claimed.results.filter((row) => updatedIds.has(row.deliveryId));
}

export interface ConvexDeliveryFinish {
  state: "delivered" | "pending" | "terminal";
  now: string;
  nextAttemptAt?: string;
  errorJson?: string;
}

export async function finishConvexDelivery(
  d1: D1Database,
  deliveryId: string,
  leaseOwner: string,
  input: ConvexDeliveryFinish,
): Promise<void> {
  const delivered = input.state === "delivered";
  // Installation health must read the owned lease before the outbox update clears it.
  await d1.batch([
    d1
      .prepare(`UPDATE convex_installations SET
        last_delivered_version = CASE WHEN ? THEN MAX(COALESCE(last_delivered_version, 0), (SELECT environment_version FROM config_webhook_deliveries WHERE delivery_id = ?)) ELSE last_delivered_version END,
        last_delivered_at = CASE WHEN ? THEN ? ELSE last_delivered_at END,
        latest_delivery_error_json = CASE WHEN ? THEN NULL ELSE ? END,
        updated_at = ?
        WHERE installation_id = (SELECT installation_id FROM config_webhook_deliveries WHERE delivery_id = ?)
          AND status = 'active'
          AND EXISTS (SELECT 1 FROM config_webhook_deliveries
            WHERE delivery_id = ? AND state = 'leased' AND lease_owner = ?)`)
      .bind(
        delivered ? 1 : 0,
        deliveryId,
        delivered ? 1 : 0,
        input.now,
        delivered ? 1 : 0,
        input.errorJson ?? null,
        input.now,
        deliveryId,
        deliveryId,
        leaseOwner,
      ),
    d1
      .prepare(`UPDATE config_webhook_deliveries SET state = ?, attempt_count = attempt_count + 1,
        next_attempt_at = COALESCE(?, next_attempt_at), last_error_json = ?, delivered_at = ?,
        lease_owner = NULL, lease_expires_at = NULL
        WHERE delivery_id = ? AND state = 'leased' AND lease_owner = ?
          AND EXISTS (SELECT 1 FROM convex_installations
            WHERE installation_id = config_webhook_deliveries.installation_id AND status = 'active')`)
      .bind(
        input.state,
        input.nextAttemptAt ?? null,
        input.errorJson ?? null,
        delivered ? input.now : null,
        deliveryId,
        leaseOwner,
      ),
  ]);
}
