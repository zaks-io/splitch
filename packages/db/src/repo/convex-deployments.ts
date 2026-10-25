import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";

export function makeConvexDeploymentRepo(d1: D1Database) {
  return {
    async markDeploymentMissing(
      installationId: string,
      probeToken: string,
      now: string,
    ): Promise<void> {
      await d1.batch([
        d1
          .prepare(`UPDATE convex_installations SET
          deployment_missing_at = COALESCE(deployment_missing_at, ?),
          deployment_checked_at = ?, updated_at = ?, deployment_probe_token = NULL
          WHERE installation_id = ? AND status = 'active' AND deployment_probe_token = ?`)
          .bind(now, now, now, installationId, probeToken),
        d1
          .prepare(`UPDATE config_webhook_deliveries SET state = 'suppressed',
          lease_owner = NULL, lease_expires_at = NULL
          WHERE installation_id = ? AND state IN ('pending', 'leased')
            AND EXISTS (SELECT 1 FROM convex_installations installation
              WHERE installation.installation_id = config_webhook_deliveries.installation_id
                AND installation.status = 'active' AND installation.deployment_missing_at IS NOT NULL)`)
          .bind(installationId),
      ]);
    },

    async dormantDeployments(limit: number) {
      if (!Number.isInteger(limit) || limit < 1)
        throw new Error("Convex deployment probe limit must be a positive integer");
      const rows = await d1
        .prepare(`SELECT installation_id AS installationId,
          app_id AS appId, environment_id AS environmentId, callback_url AS callbackUrl
        FROM convex_installations
        WHERE status = 'active' AND deployment_missing_at IS NOT NULL
        ORDER BY deployment_checked_at, installation_id LIMIT ?`)
        .bind(limit)
        .all<{
          installationId: string;
          appId: string;
          environmentId: string;
          callbackUrl: string;
        }>();
      return rows.results;
    },

    async recordDeploymentCheck(installationId: string, now: string): Promise<void> {
      await d1
        .prepare(`UPDATE convex_installations SET deployment_checked_at = ?, deployment_probe_token = NULL
        WHERE installation_id = ? AND status = 'active'`)
        .bind(now, installationId)
        .run();
    },

    async reactivateDeployment(
      scope: EnvScope,
      installationId: string,
      now: string,
    ): Promise<void> {
      assertMintedScope(scope);
      const deliveryId = crypto.randomUUID();
      // Enqueue while the dormant predicate still holds so retries cannot reset an owned delivery.
      await d1.batch([
        d1
          .prepare(`INSERT INTO config_webhook_deliveries (
            delivery_id, installation_id, app_id, environment_id, environment_version,
            body_json, state, attempt_count, next_attempt_at, created_at
          ) SELECT ?, installation.installation_id, installation.app_id, installation.environment_id,
            environment.config_version,
            json_object('deliveryId', ?, 'type', 'config.changed', 'appId', installation.app_id,
              'environmentId', installation.environment_id, 'environmentVersion', environment.config_version,
              'changed', json_object('entity', 'environment', 'id', installation.environment_id)),
            'pending', 0, ?, ?
          FROM convex_installations installation JOIN environments environment
            ON environment.id = installation.environment_id AND environment.app_id = installation.app_id
          WHERE installation.app_id = ? AND installation.environment_id = ?
            AND installation.installation_id = ? AND installation.status = 'active'
            AND installation.deployment_missing_at IS NOT NULL
          ON CONFLICT(installation_id, environment_version) DO UPDATE SET
            state = 'pending', attempt_count = 0, next_attempt_at = excluded.next_attempt_at,
            lease_owner = NULL, lease_expires_at = NULL, last_error_json = NULL,
            completed_at = NULL
          WHERE config_webhook_deliveries.state IN ('suppressed', 'terminal')`)
          .bind(deliveryId, deliveryId, now, now, scope.appId, scope.environmentId, installationId),
        d1
          .prepare(`UPDATE convex_installations SET deployment_missing_at = NULL,
          deployment_checked_at = ?, preparation_retry_at = NULL, updated_at = ?, deployment_probe_token = NULL
          WHERE app_id = ? AND environment_id = ? AND installation_id = ?
            AND status = 'active' AND deployment_missing_at IS NOT NULL`)
          .bind(now, now, scope.appId, scope.environmentId, installationId),
      ]);
    },
  };
}
