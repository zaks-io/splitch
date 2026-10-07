import type { ConvexInstallationRow } from "@splitch/db";
import { envScope } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";

export function convexPrincipalScope(
  principal: HandlerArgs<unknown>["principal"],
  requestId: string,
) {
  if (!principal.appId || !principal.environmentId)
    return renderError(
      { code: "FORBIDDEN", message: "API Key is not bound to an App and Environment", details: {} },
      { requestId },
    );
  return envScope(principal.appId, principal.environmentId);
}

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
