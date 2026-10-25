export interface IntegrationDeliveryLag {
  appId: string;
  environmentId: string;
  oldestOutstandingAt: string;
  healthyInstallationsWaiting: number;
}

/** System sweep bounded by outstanding work, independent of completed delivery history. */
export async function readIntegrationDeliveryLag(
  d1: D1Database,
  provider: "convex" | "cloudflare",
  now: string,
): Promise<IntegrationDeliveryLag[]> {
  const convex = provider === "convex";
  const deliveryTable = convex ? "config_webhook_deliveries" : "cloudflare_config_deliveries";
  const installationTable = convex ? "convex_installations" : "cloudflare_installations";
  const deliveryIndex = convex
    ? "config_webhook_delivery_lease_idx"
    : "cloudflare_config_delivery_lease_idx";
  // Cloudflare records delivery health but has no installation preparation cooldown.
  const preparation = convex
    ? "AND (installation.preparation_retry_at IS NULL OR installation.preparation_retry_at <= ?)"
    : "";
  const statement = d1.prepare(`SELECT delivery.app_id AS appId,
      delivery.environment_id AS environmentId,
      MIN(delivery.created_at) AS oldestOutstandingAt,
      COUNT(DISTINCT delivery.installation_id) AS healthyInstallationsWaiting
    FROM ${deliveryTable} delivery INDEXED BY ${deliveryIndex}
    CROSS JOIN ${installationTable} installation
      ON installation.installation_id = delivery.installation_id
      AND installation.app_id = delivery.app_id
      AND installation.environment_id = delivery.environment_id
    WHERE delivery.state IN ('pending', 'leased')
      AND installation.status = 'active'
      AND installation.latest_delivery_error_json IS NULL
      ${preparation}
    GROUP BY delivery.app_id, delivery.environment_id`);
  const result = await (convex ? statement.bind(now) : statement).all<IntegrationDeliveryLag>();
  return result.results;
}
