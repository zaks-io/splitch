export const DELIVERY_SEND_CONCURRENCY = 6;
export const DELIVERY_BATCH_SIZE = 6;
export const DELIVERY_SEND_TIMEOUT_MS = 5_000;
export const DELIVERY_PREPARATION_BUDGET_MS = 5_000;
export const DELIVERY_COMPLETION_BUDGET_MS = 10_000;
export const DELIVERY_LEASE_MS = 30_000;

if (
  DELIVERY_BATCH_SIZE > DELIVERY_SEND_CONCURRENCY ||
  DELIVERY_PREPARATION_BUDGET_MS + DELIVERY_SEND_TIMEOUT_MS + DELIVERY_COMPLETION_BUDGET_MS >=
    DELIVERY_LEASE_MS
) {
  throw new Error(
    "Integration delivery lease must cover preparation, send and completion without queuing",
  );
}

export interface IntegrationDeliveryDispatchPolicy {
  claimLimit: number;
  concurrency: number;
  sendTimeoutMs: number | null;
  leaseMs: number;
  clock: {
    now: () => Date;
    outcomeTime: (claimedAt: Date) => Date;
  };
}

export function cronDeliveryPolicy(
  provider: "convex" | "cloudflare",
  now = () => new Date(),
): IntegrationDeliveryDispatchPolicy {
  return {
    claimLimit: 25,
    concurrency: 25,
    sendTimeoutMs: provider === "convex" ? 5_000 : null,
    leaseMs: 30_000,
    clock: { now, outcomeTime: (claimedAt) => claimedAt },
  };
}

export function coordinatorDeliveryPolicy(
  now = () => new Date(),
): IntegrationDeliveryDispatchPolicy {
  return {
    claimLimit: DELIVERY_BATCH_SIZE,
    concurrency: DELIVERY_SEND_CONCURRENCY,
    sendTimeoutMs: DELIVERY_SEND_TIMEOUT_MS,
    leaseMs: DELIVERY_LEASE_MS,
    clock: { now, outcomeTime: now },
  };
}

export function deliverySendSignal(timeoutMs: number | null): AbortSignal | undefined {
  return timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
}
