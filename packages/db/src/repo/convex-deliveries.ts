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
  // Start with eligible installations so blocked history cannot inflate the due-row scan.
  const [leased, claimed] = await d1.batch<ConfigWebhookDeliveryRow>([
    d1
      .prepare(`UPDATE config_webhook_deliveries
        SET state = 'leased', lease_owner = ?, lease_expires_at = ?
        WHERE delivery_id IN (
          SELECT delivery.delivery_id FROM convex_installations installation
          CROSS JOIN config_webhook_deliveries delivery
            ON delivery.installation_id = installation.installation_id
            AND delivery.environment_version = (
              SELECT environment_version FROM config_webhook_deliveries newest
                INDEXED BY config_webhook_delivery_outstanding_idx
              WHERE newest.installation_id = installation.installation_id
                AND newest.state IN ('pending', 'leased')
              ORDER BY environment_version DESC LIMIT 1
            )
          WHERE installation.status = 'active'
            AND (installation.preparation_retry_at IS NULL OR installation.preparation_retry_at <= ?)
            AND NOT EXISTS (SELECT 1 FROM config_webhook_deliveries busy
              WHERE busy.installation_id = delivery.installation_id
                AND busy.state = 'leased' AND busy.lease_expires_at > ?)
            AND ((delivery.state = 'pending' AND delivery.next_attempt_at <= ?)
              OR (delivery.state = 'leased' AND delivery.lease_expires_at <= ?))
          ORDER BY delivery.next_attempt_at, delivery.delivery_id LIMIT ?
        ) RETURNING delivery_id AS deliveryId`)
      .bind(leaseOwner, leaseExpiresAt, now, now, now, now, limit),
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
      .prepare(`UPDATE config_webhook_deliveries SET state = 'suppressed',
          lease_owner = NULL, lease_expires_at = NULL
        WHERE installation_id = (SELECT installation_id FROM config_webhook_deliveries WHERE delivery_id = ?)
          AND (state = 'pending' OR (state = 'leased' AND lease_expires_at <= ?))
          AND environment_version < (SELECT environment_version FROM config_webhook_deliveries WHERE delivery_id = ?)
          AND ? = 1
          AND EXISTS (SELECT 1 FROM config_webhook_deliveries owned
            JOIN convex_installations installation ON installation.installation_id = owned.installation_id
            WHERE owned.delivery_id = ? AND owned.state = 'leased' AND owned.lease_owner = ?
              AND installation.status = 'active')`)
      .bind(deliveryId, input.now, deliveryId, delivered ? 1 : 0, deliveryId, leaseOwner),
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
