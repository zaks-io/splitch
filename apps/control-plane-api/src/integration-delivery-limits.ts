export const DELIVERY_SEND_CONCURRENCY = 6;
export const DELIVERY_BATCH_SIZE = 6;
export const DELIVERY_SEND_TIMEOUT_MS = 5_000;
export const DELIVERY_PREPARATION_BUDGET_MS = 5_000;
export const DELIVERY_COMPLETION_BUDGET_MS = 10_000;
export const DELIVERY_LEASE_MS = 30_000;
// Count actual D1 calls and HTTP requests. Stop claiming at half the default limit,
// leaving room for the six in-flight rows, snapshot reads, renewals, completions,
// deletion probes, scheduling and fault reporting.
// https://developers.cloudflare.com/workers/platform/limits/#subrequests
export const DELIVERY_RUN_SUBREQUEST_BUDGET = 5_000;

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
    leaseTime: () => Date;
  };
}

export function cronDeliveryPolicy(
  provider: "convex" | "cloudflare",
  now = () => new Date(),
  leaseNow = () => new Date(),
): IntegrationDeliveryDispatchPolicy {
  return {
    claimLimit: 25,
    concurrency: 25,
    sendTimeoutMs: provider === "convex" ? 5_000 : null,
    leaseMs: 30_000,
    clock: { now, outcomeTime: (claimedAt) => claimedAt, leaseTime: leaseNow },
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
    clock: { now, outcomeTime: now, leaseTime: now },
  };
}

export function deliverySendSignal(timeoutMs: number | null): AbortSignal | undefined {
  return timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
}
