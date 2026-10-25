import { sql } from "drizzle-orm";
import { assertMintedScope, type TenantScope } from "./scope";

export function buildPrivacyJobsReconciliationPredicate(input: {
  now: string;
  updatedBefore: string;
}) {
  return sql`((status IN ('queued', 'failed') AND updated_at <= ${input.updatedBefore})
             OR (status = 'running' AND lease_expires_at <= ${input.now}))`;
}

export function buildExpiredPrivacyArtifactsPredicate(now: string) {
  return sql`artifact_key IS NOT NULL AND artifact_expires_at <= ${now}`;
}

export function buildPendingPersonalAccessTokenRotationsPredicate(before: string) {
  return sql`phase NOT IN ('completed','retired') AND updated_at <= ${before}`;
}

export function buildExpiredPersonalAccessTokenRotationsPredicate(cutoff: string) {
  return sql`phase IN ('completed','retired') AND updated_at < ${cutoff}`;
}

export function buildExpiredPersonalAccessTokenStepUpUsesPredicate(cutoff: string) {
  return sql`expires_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM personal_access_token_rotations r WHERE r.step_up_jti = u.jti)`;
}

export function buildDueConvexDeliveriesQuery(now: string, scope?: TenantScope) {
  if (scope) assertMintedScope(scope);
  return sql`CROSS JOIN config_webhook_deliveries delivery
            ON delivery.installation_id = installation.installation_id
            AND delivery.environment_version = (
              SELECT environment_version FROM config_webhook_deliveries newest
                INDEXED BY config_webhook_delivery_outstanding_idx
              WHERE newest.installation_id = installation.installation_id
                AND newest.state IN ('pending', 'leased')
              ORDER BY environment_version DESC LIMIT 1
            )
          WHERE installation.status = 'active'
            ${deliveryScopePredicate(scope, "installation")}
            AND (installation.preparation_retry_at IS NULL OR installation.preparation_retry_at <= ${now})
            AND NOT EXISTS (SELECT 1 FROM config_webhook_deliveries busy
              WHERE busy.installation_id = delivery.installation_id
                AND busy.state = 'leased' AND busy.lease_expires_at > ${now})
            AND ((delivery.state = 'pending' AND delivery.next_attempt_at <= ${now})
              OR (delivery.state = 'leased' AND delivery.lease_expires_at <= ${now}))`;
}

export function buildDueCloudflareDeliveriesQuery(now: string, scope?: TenantScope) {
  if (scope) assertMintedScope(scope);
  return sql`JOIN cloudflare_installations installation
            ON installation.installation_id = delivery.installation_id
          WHERE installation.status = 'active'
            ${deliveryScopePredicate(scope, "delivery")}
            AND ((delivery.state = 'pending' AND delivery.next_attempt_at <= ${now})
              OR (delivery.state = 'leased' AND delivery.lease_expires_at <= ${now}))
            AND NOT EXISTS (
              SELECT 1 FROM cloudflare_config_deliveries newer
              WHERE newer.installation_id = delivery.installation_id
                AND newer.environment_version > delivery.environment_version
                AND newer.state IN ('pending', 'leased')
            )`;
}

export function buildDueSentryInstallationsPredicate(now: string) {
  return sql`status = 'active' AND next_attempt_at <= ${now}
          AND EXISTS (
            SELECT 1 FROM flag_change_events event
            WHERE event.app_id IN (
              SELECT id FROM apps WHERE organization_id = sentry_installations.org_id
            ) AND event.seq > COALESCE(sentry_installations.last_delivered_seq, 0)
            AND event.temporary_environment = 0
          )`;
}

export function personalAccessTokenRetentionCutoff(now: string) {
  return new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
}

function deliveryScopePredicate(
  scope: TenantScope | undefined,
  alias: "installation" | "delivery",
) {
  if (!scope) return sql``;
  const appId = alias === "installation" ? sql`installation.app_id` : sql`delivery.app_id`;
  const environmentId =
    alias === "installation" ? sql`installation.environment_id` : sql`delivery.environment_id`;
  return sql`AND ${appId} = ${scope.appId}
    ${"environmentId" in scope ? sql`AND ${environmentId} = ${scope.environmentId}` : sql``}`;
}
