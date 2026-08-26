import type { SentryInstallationRow } from "@splitch/db";

/**
 * The wire shape of an installation.
 *
 * An installation names the Sentry organization a whole splitch Organization's
 * Flag changes are published to, so `orgId` is the only scope on it: Sentry
 * holds one signing secret per provider per organization and its flag log has no
 * project or environment axis to narrow against.
 */

export function installationStatusResponse(row: SentryInstallationRow) {
  return {
    installationId: row.installationId,
    orgId: row.orgId,
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
