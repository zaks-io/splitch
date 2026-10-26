import { sql } from "drizzle-orm";
import { createDb, type Db } from "./client";

export interface IntegrationDeliveryLag {
  appId: string;
  environmentId: string;
  oldestOutstandingAt: string;
  healthyInstallationsWaiting: number;
}

/** System sweep bounded by outstanding work, independent of completed delivery history. */
export function buildIntegrationDeliveryLagQuery(
  db: Db,
  provider: "convex" | "cloudflare",
  now: string,
) {
  const convex = provider === "convex";
  const deliveryTable = convex ? sql`config_webhook_deliveries` : sql`cloudflare_config_deliveries`;
  const installationTable = convex ? sql`convex_installations` : sql`cloudflare_installations`;
  const deliveryIndex = convex
    ? sql`config_webhook_delivery_lease_idx`
    : sql`cloudflare_config_delivery_lease_idx`;
  // Cloudflare records delivery health but has no installation preparation cooldown.
  const preparation = convex
    ? sql`AND (installation.preparation_retry_at IS NULL OR installation.preparation_retry_at <= ${now})`
    : sql``;
  // Triggers use CURRENT_TIMESTAMP; application inserts use ISO timestamps.
  return db
    .select({
      appId: sql<string>`delivery.app_id`,
      environmentId: sql<string>`delivery.environment_id`,
      oldestOutstandingAt: sql<string>`MIN(strftime('%Y-%m-%dT%H:%M:%fZ', delivery.created_at))`,
      healthyInstallationsWaiting: sql<number>`COUNT(DISTINCT delivery.installation_id)`,
    })
    .from(sql`${deliveryTable} delivery INDEXED BY ${deliveryIndex}
    CROSS JOIN ${installationTable} installation
      ON installation.installation_id = delivery.installation_id
      AND installation.app_id = delivery.app_id
      AND installation.environment_id = delivery.environment_id`)
    .where(sql`delivery.state IN ('pending', 'leased')
      AND installation.status = 'active'
      AND installation.latest_delivery_error_json IS NULL
      ${preparation}`)
    .groupBy(sql`delivery.app_id`, sql`delivery.environment_id`);
}

export async function readIntegrationDeliveryLag(
  d1: D1Database,
  provider: "convex" | "cloudflare",
  now: string,
): Promise<IntegrationDeliveryLag[]> {
  return buildIntegrationDeliveryLagQuery(createDb(d1), provider, now).all();
}
