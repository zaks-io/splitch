const DELIVERY_PERMIT_PREFIX = "privacy:raw-delivery:";

/**
 * The queue consumer cannot hold several privacy Durable Object requests open
 * around one cross-tenant Tinybird batch. A durable permit extends the same
 * exclusion invariant across that gap: deletion first installs suppression,
 * then refuses proof until every admitted append releases its permit.
 */

export function deliveryPermitId(value: Record<string, unknown>): string | undefined {
  const deliveryId = value.deliveryId;
  if (deliveryId === undefined) return undefined;
  if (typeof deliveryId !== "string" || deliveryId.length === 0 || deliveryId.length > 512) {
    throw new Error("Raw event delivery permit id is invalid");
  }
  return deliveryId;
}

export async function recordDeliveryPermit(
  storage: DurableObjectStorage,
  deliveryId: string | undefined,
): Promise<void> {
  if (deliveryId === undefined) return;
  await storage.put(`${DELIVERY_PERMIT_PREFIX}${deliveryId}`, true);
}

export async function completeDeliveryPermit(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const deliveryId = deliveryPermitId(body);
  if (deliveryId === undefined) throw new Error("Raw event delivery permit id is unavailable");
  await releaseDeliveryPermit(storage, deliveryId);
  return Response.json({ completed: true });
}

export async function releaseDeliveryPermit(
  storage: DurableObjectStorage,
  deliveryId: string,
): Promise<void> {
  await storage.delete(`${DELIVERY_PERMIT_PREFIX}${deliveryId}`);
}

export async function hasDeliveryPermits(storage: DurableObjectStorage): Promise<boolean> {
  return (await storage.list({ prefix: DELIVERY_PERMIT_PREFIX, limit: 1 })).size > 0;
}
