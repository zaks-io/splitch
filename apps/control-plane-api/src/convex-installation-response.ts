import type { ConvexInstallationRow } from "@splitch/db";
import { envScope } from "@splitch/db";

interface DeliveryHealth {
  pendingCount: number;
  terminalCount: number;
  oldestPendingAgeMs: number | null;
}

/**
 * One wire shape and one minted scope for both Convex doors. The API Key door
 * derives its scope from the credential while the operator door names it in the
 * path, but neither distinction belongs in the installation response.
 */
export function convexScope(params: { appId: string; environmentId: string }) {
  return envScope(params.appId, params.environmentId);
}

export function convexInstallationStatusResponse(
  row: ConvexInstallationRow & DeliveryHealth,
  environmentVersion: number,
) {
  return {
    installationId: row.installationId,
    appId: row.appId,
    environmentId: row.environmentId,
    environmentVersion,
    status: row.status,
    callbackUrl: row.callbackUrl,
    lastDeliveredVersion: row.lastDeliveredVersion,
    lastDeliveredAt: row.lastDeliveredAt,
    pendingCount: row.pendingCount,
    oldestPendingAgeMs: row.oldestPendingAgeMs,
    terminalCount: row.terminalCount,
    latestDeliveryError: row.latestDeliveryErrorJson
      ? JSON.parse(row.latestDeliveryErrorJson)
      : null,
  };
}
