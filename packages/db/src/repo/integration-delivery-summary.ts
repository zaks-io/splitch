import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { assertMintedScope, type EnvScope } from "./scope";

export async function readIntegrationDeliverySummary(db: Db, scope: EnvScope, nowMs: number) {
  assertMintedScope(scope);
  const [convex, cloudflare] = await Promise.all([
    readProviderSummary(db, scope, nowMs, "convex"),
    readProviderSummary(db, scope, nowMs, "cloudflare"),
  ]);
  return { convex, cloudflare };
}

async function readProviderSummary(
  db: Db,
  scope: EnvScope,
  nowMs: number,
  provider: "convex" | "cloudflare",
) {
  const convex = provider === "convex";
  const table = sql.raw(convex ? "config_webhook_deliveries" : "cloudflare_config_deliveries");
  const installation = sql.raw(convex ? "convex_installations" : "cloudflare_installations");
  const index = sql.raw(
    convex
      ? "config_webhook_delivery_outstanding_idx"
      : "cloudflare_config_delivery_outstanding_idx",
  );
  // Unlike healthy-only lag alerts, this operator read includes failing deliveries. Start from
  // scoped installations and their outstanding index so retained history is never scanned.
  const [rows] = await db.batch([
    db
      .select({
        pendingCount: sql<number>`COUNT(CASE WHEN delivery.state = 'pending' THEN 1 END)`,
        leasedCount: sql<number>`COUNT(CASE WHEN delivery.state = 'leased' THEN 1 END)`,
        oldestOutstandingAt: sql<
          string | null
        >`MIN(strftime('%Y-%m-%dT%H:%M:%fZ', delivery.created_at))`,
      })
      .from(sql`${installation} installation CROSS JOIN ${table} delivery INDEXED BY ${index}
        ON delivery.installation_id = installation.installation_id`)
      .where(sql`installation.app_id = ${scope.appId} AND installation.environment_id = ${scope.environmentId}
        AND delivery.app_id = ${scope.appId} AND delivery.environment_id = ${scope.environmentId}
        AND delivery.state IN ('pending', 'leased')`),
  ]);
  const row = rows[0];
  if (!row) throw new Error("Integration delivery summary: missing D1 aggregate result");
  if (row.oldestOutstandingAt === null && row.pendingCount + row.leasedCount > 0)
    throw new Error("Integration delivery summary: outstanding delivery has invalid timestamp");
  const oldest = row.oldestOutstandingAt === null ? null : Date.parse(row.oldestOutstandingAt);
  if (oldest !== null && !Number.isFinite(oldest))
    throw new Error("Integration delivery summary: invalid outstanding timestamp");
  return {
    pendingCount: row.pendingCount,
    leasedCount: row.leasedCount,
    oldestOutstandingAgeMs: oldest === null ? null : Math.max(0, nowMs - oldest),
  };
}
