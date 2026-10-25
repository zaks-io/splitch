import type { Repository } from "@splitch/db";
import {
  DELIVERY_COMPLETION_BUDGET_MS,
  DELIVERY_SEND_TIMEOUT_MS,
  type IntegrationDeliveryDispatchPolicy,
} from "./integration-delivery-limits";

export async function renewDeliveryLeaseBeforeSend(
  delivery: { deliveryId: string; leaseExpiresAt: number },
  leaseOwner: string,
  policy: IntegrationDeliveryDispatchPolicy,
  renewLease: Repository["convex"]["renewDeliveryLease"],
): Promise<boolean> {
  const now = policy.clock.leaseTime();
  // Cron Cloudflare HTTP stays unbounded; its pre-send check uses the normal send allowance.
  const sendBudget = policy.sendTimeoutMs ?? DELIVERY_SEND_TIMEOUT_MS;
  if (delivery.leaseExpiresAt - now.getTime() >= sendBudget + DELIVERY_COMPLETION_BUDGET_MS)
    return true;
  const renewalNow = policy.clock.leaseTime();
  const renewedDeadline = renewalNow.getTime() + policy.leaseMs;
  const renewed = await renewLease(
    delivery.deliveryId,
    leaseOwner,
    renewalNow.toISOString(),
    new Date(renewedDeadline).toISOString(),
  );
  return (
    renewed &&
    renewedDeadline - policy.clock.leaseTime().getTime() >=
      sendBudget + DELIVERY_COMPLETION_BUDGET_MS
  );
}
