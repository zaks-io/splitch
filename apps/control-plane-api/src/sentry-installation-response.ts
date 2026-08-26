import type { SentryInstallationRow } from "@splitch/db";
import { envScope } from "@splitch/db";

/**
 * The wire shape of an installation, and the minted scope every Sentry handler
 * reads under. Kept apart from the handlers so the tenant scope is derived in
 * exactly one place: an installation names the Sentry organization a whole
 * Environment's Flag changes are published to, so a scope assembled ad hoc per
 * handler is the mistake worth making impossible.
 */

export function sentryScope(params: { appId: string; environmentId: string }) {
  return envScope(params.appId, params.environmentId);
}

export function installationStatusResponse(row: SentryInstallationRow) {
  return {
    installationId: row.installationId,
    appId: row.appId,
    environmentId: row.environmentId,
    webhookUrl: row.webhookUrl,
    status: row.status,
    lastDeliveredSeq: row.lastDeliveredSeq,
    lastDeliveredAt: row.lastDeliveredAt,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    latestDeliveryError: row.latestDeliveryErrorJson
      ? JSON.parse(row.latestDeliveryErrorJson)
      : null,
  };
}
