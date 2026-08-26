import type { EnvScope } from "./scope";

interface DeliveryHealthAggregateRow {
  installationId: string;
  pendingCount: number | null;
  terminalCount: number | null;
  oldestPendingAt: string | null;
}

export interface DeliveryHealth {
  pendingCount: number;
  terminalCount: number;
  oldestPendingAgeMs: number | null;
}

type DeliveryTable = "cloudflare_config_deliveries" | "config_webhook_deliveries";

export async function listPushInstallations<T extends { installationId: string }>(
  d1: D1Database,
  scope: EnvScope,
  installationSelect: string,
  deliveryTable: DeliveryTable,
): Promise<Array<T & DeliveryHealth>> {
  const nowMs = Date.now();
  const [installations, deliveryHealth] = await d1.batch<T | DeliveryHealthAggregateRow>([
    d1
      .prepare(
        `${installationSelect} WHERE app_id = ? AND environment_id = ? ORDER BY created_at DESC`,
      )
      .bind(scope.appId, scope.environmentId),
    d1
      .prepare(`SELECT installation_id AS installationId,
        SUM(CASE WHEN state IN ('pending', 'leased') THEN 1 ELSE 0 END) AS pendingCount,
        SUM(CASE WHEN state = 'terminal' THEN 1 ELSE 0 END) AS terminalCount,
        MIN(CASE WHEN state IN ('pending', 'leased') THEN created_at END) AS oldestPendingAt
        FROM ${deliveryTable} WHERE app_id = ? AND environment_id = ? GROUP BY installation_id`)
      .bind(scope.appId, scope.environmentId),
  ]);
  if (!installations || !deliveryHealth) {
    throw new Error("push installation list: D1 batch did not return both statement results");
  }
  const healthByInstallationId = new Map(
    (deliveryHealth.results as DeliveryHealthAggregateRow[]).map((row) => [
      row.installationId,
      toDeliveryHealth(row, nowMs),
    ]),
  );
  return (installations.results as T[]).map((installation) => ({
    ...installation,
    ...(healthByInstallationId.get(installation.installationId) ?? EMPTY_DELIVERY_HEALTH),
  }));
}

const EMPTY_DELIVERY_HEALTH: DeliveryHealth = {
  pendingCount: 0,
  terminalCount: 0,
  oldestPendingAgeMs: null,
};

function toDeliveryHealth(row: DeliveryHealthAggregateRow, nowMs: number): DeliveryHealth {
  const oldestMs = row.oldestPendingAt ? Date.parse(row.oldestPendingAt) : Number.NaN;
  return {
    pendingCount: row.pendingCount ?? 0,
    terminalCount: row.terminalCount ?? 0,
    oldestPendingAgeMs: Number.isFinite(oldestMs) ? Math.max(0, nowMs - oldestMs) : null,
  };
}
