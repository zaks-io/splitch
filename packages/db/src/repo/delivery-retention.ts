export type DeliveryRetentionInput = { completedBefore: string; limit: number };

export function pruneConvexDeliveries(d1: D1Database, input: DeliveryRetentionInput) {
  return pruneDeliveries(d1, "config_webhook_deliveries", input);
}

export function pruneCloudflareDeliveries(d1: D1Database, input: DeliveryRetentionInput) {
  return pruneDeliveries(d1, "cloudflare_config_deliveries", input);
}

async function pruneDeliveries(
  d1: D1Database,
  table: "config_webhook_deliveries" | "cloudflare_config_deliveries",
  input: DeliveryRetentionInput,
): Promise<number> {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new Error("delivery retention: limit must be a positive integer");
  }
  if (new Date(input.completedBefore).toISOString() !== input.completedBefore) {
    throw new Error("delivery retention: cutoff must be a canonical UTC timestamp");
  }
  const index =
    table === "config_webhook_deliveries"
      ? "config_webhook_delivery_completed_idx"
      : "cloudflare_config_delivery_completed_idx";
  // One atomic statement avoids deleting a row rearmed between selection and deletion.
  const result = await d1
    .prepare(
      `DELETE FROM ${table}
       WHERE delivery_id IN (
           SELECT delivery_id FROM ${table} INDEXED BY ${index}
           WHERE state IN ('delivered', 'terminal', 'suppressed') AND completed_at < ?
           ORDER BY completed_at LIMIT ?
         )`,
    )
    .bind(input.completedBefore, Math.min(input.limit, 1_000))
    .run();
  return result.meta.changes;
}
