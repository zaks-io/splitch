import { and, eq, gt } from "drizzle-orm";
import type { cloudflareConfigDeliveries, configWebhookDeliveries } from "../schema/integrations";
import { createDb } from "./client";

export async function renewDeliveryLease(
  d1: D1Database,
  table: typeof configWebhookDeliveries | typeof cloudflareConfigDeliveries,
  deliveryId: string,
  leaseOwner: string,
  now: string,
  leaseExpiresAt: string,
): Promise<boolean> {
  const result = await createDb(d1)
    .update(table)
    .set({ leaseExpiresAt })
    .where(
      and(
        eq(table.deliveryId, deliveryId),
        eq(table.state, "leased"),
        eq(table.leaseOwner, leaseOwner),
        gt(table.leaseExpiresAt, now),
      ),
    )
    .run();
  return result.meta.changes === 1;
}
