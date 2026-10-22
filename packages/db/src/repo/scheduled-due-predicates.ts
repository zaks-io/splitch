import type { TenantScope } from "./scope";

export function buildPrivacyJobsReconciliationPredicate(input: {
  now: string;
  updatedBefore: string;
}) {
  return {
    sql: `((status IN ('queued', 'failed') AND updated_at <= ?)
             OR (status = 'running' AND lease_expires_at <= ?))`,
    params: [input.updatedBefore, input.now],
  };
}

export function buildExpiredPrivacyArtifactsPredicate(now: string) {
  return {
    sql: `artifact_key IS NOT NULL AND artifact_expires_at <= ?`,
    params: [now],
  };
}

export function buildPendingPersonalAccessTokenRotationsPredicate(before: string) {
  return {
    sql: `phase NOT IN ('completed','retired') AND updated_at <= ?`,
    params: [before],
  };
}

export function buildExpiredPersonalAccessTokenRotationsPredicate(cutoff: string) {
  return {
    sql: `phase IN ('completed','retired') AND updated_at < ?`,
    params: [cutoff],
  };
}

export function buildExpiredPersonalAccessTokenStepUpUsesPredicate(cutoff: string) {
  return {
    sql: `expires_at < ?
        AND NOT EXISTS (SELECT 1 FROM personal_access_token_rotations r WHERE r.step_up_jti = u.jti)`,
    params: [cutoff],
  };
}

export function buildDueConvexDeliveriesQuery(now: string) {
  return {
    sql: `FROM convex_installations installation
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
              OR (delivery.state = 'leased' AND delivery.lease_expires_at <= ?))`,
    params: [now, now, now, now],
  };
}

export function buildDueCloudflareDeliveriesQuery(now: string, scope?: TenantScope) {
  return {
    sql: `FROM cloudflare_config_deliveries delivery
          JOIN cloudflare_installations installation
            ON installation.installation_id = delivery.installation_id
          WHERE installation.status = 'active'
            ${scope ? "AND delivery.app_id = ?" : ""}
            AND ((delivery.state = 'pending' AND delivery.next_attempt_at <= ?)
              OR (delivery.state = 'leased' AND delivery.lease_expires_at <= ?))
            AND NOT EXISTS (
              SELECT 1 FROM cloudflare_config_deliveries newer
              WHERE newer.installation_id = delivery.installation_id
                AND newer.environment_version > delivery.environment_version
                AND newer.state IN ('pending', 'leased')
            )`,
    params: [...(scope ? [scope.appId] : []), now, now],
  };
}

export function buildDueSentryInstallationsPredicate(now: string) {
  return {
    sql: `status = 'active' AND next_attempt_at <= ?
          AND EXISTS (
            SELECT 1 FROM flag_change_events event
            WHERE event.app_id IN (
              SELECT id FROM apps WHERE organization_id = sentry_installations.org_id
            ) AND event.seq > COALESCE(sentry_installations.last_delivered_seq, 0)
            AND event.temporary_environment = 0
          )`,
    params: [now],
  };
}

export function personalAccessTokenRetentionCutoff(now: string) {
  return new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
}
