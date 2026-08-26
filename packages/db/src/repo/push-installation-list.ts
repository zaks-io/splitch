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
  return {
    pendingCount: row.pendingCount ?? 0,
    terminalCount: row.terminalCount ?? 0,
    // A null timestamp means nothing is pending. An unparseable one means the
    // stored row is corrupt, and mapping it to the same null would render a
    // stalled backlog as a healthy Environment.
    oldestPendingAgeMs:
      row.oldestPendingAt === null ? null : pendingAgeMs(row.oldestPendingAt, nowMs),
  };
}

function pendingAgeMs(oldestPendingAt: string, nowMs: number): number {
  const oldestMs = Date.parse(oldestPendingAt);
  if (!Number.isFinite(oldestMs)) {
    throw new Error(
      `push installation list: unparseable oldest pending timestamp ${oldestPendingAt}`,
    );
  }
  return Math.max(0, nowMs - oldestMs);
}
