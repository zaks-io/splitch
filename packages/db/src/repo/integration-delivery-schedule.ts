import { sql } from "drizzle-orm";
import type { Db } from "./client";
import {
  buildDueCloudflareDeliveriesQuery,
  buildDueConvexDeliveriesQuery,
} from "./scheduled-due-predicates";
import { assertMintedScope, type EnvScope, type TenantScope } from "./scope";

export function makeIntegrationDeliveryScheduleRepo(db: Db) {
  return {
    async environmentsWithDueDeliveries(input: { now: string; scope?: TenantScope }) {
      const convex = buildDueConvexDeliveriesQuery(input.now, input.scope);
      const cloudflare = buildDueCloudflareDeliveriesQuery(input.now, input.scope);
      const [rows] = await db.batch([
        db
          .select({ appId: sql<string>`appId`, environmentId: sql<string>`environmentId` })
          .from(sql`(
          SELECT DISTINCT installation.app_id AS appId, installation.environment_id AS environmentId
          FROM convex_installations installation ${convex}
          UNION
          SELECT DISTINCT delivery.app_id AS appId, delivery.environment_id AS environmentId
          FROM cloudflare_config_deliveries delivery ${cloudflare})`),
      ]);
      return rows;
    },

    async nextDeliveryWakeAt(scope: EnvScope, now: string): Promise<string | null> {
      assertMintedScope(scope);
      // Only outstanding rows participate. Older Convex versions cannot bypass the newest
      // version's retry or any live lease, and preparation blocks the entire installation.
      const [rows] = await db.batch([
        db
          .select({ wakeAt: sql<string | null>`MIN(wakeAt)` })
          .from(sql`(
            SELECT MAX(
              CASE delivery.state WHEN 'leased' THEN delivery.lease_expires_at
                ELSE delivery.next_attempt_at END,
              COALESCE(installation.preparation_retry_at, ${now}),
              COALESCE((SELECT MAX(busy.lease_expires_at) FROM config_webhook_deliveries busy
                WHERE busy.installation_id = installation.installation_id
                  AND busy.state = 'leased'), ${now})
            ) AS wakeAt
            FROM convex_installations installation
            CROSS JOIN config_webhook_deliveries delivery
              ON delivery.installation_id = installation.installation_id
              AND delivery.environment_version = (
                SELECT newest.environment_version FROM config_webhook_deliveries newest
                  INDEXED BY config_webhook_delivery_outstanding_idx
                WHERE newest.installation_id = installation.installation_id
                  AND newest.state IN ('pending', 'leased')
                ORDER BY newest.environment_version DESC LIMIT 1)
            WHERE installation.app_id = ${scope.appId}
              AND installation.environment_id = ${scope.environmentId}
              AND installation.status = 'active'
            UNION ALL
            SELECT CASE delivery.state WHEN 'leased' THEN delivery.lease_expires_at
              ELSE delivery.next_attempt_at END AS wakeAt
            FROM cloudflare_config_deliveries delivery
            JOIN cloudflare_installations installation
              ON installation.installation_id = delivery.installation_id
            WHERE delivery.app_id = ${scope.appId}
              AND delivery.environment_id = ${scope.environmentId}
              AND delivery.state IN ('pending', 'leased') AND installation.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM cloudflare_config_deliveries newer
                INDEXED BY cloudflare_config_delivery_outstanding_idx
                WHERE newer.installation_id = delivery.installation_id
                  AND newer.environment_version > delivery.environment_version
                  AND newer.state IN ('pending', 'leased'))
          )`)
          .where(sql`wakeAt > ${now}`),
      ]);
      const row = rows[0];
      if (!row) throw new Error("Integration delivery schedule: missing D1 aggregate result");
      return row.wakeAt;
    },
  };
}
