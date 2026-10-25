import type { Repository, TenantScope } from "@splitch/db";
import { envScope } from "@splitch/db";
import { serializeFault } from "@splitch/observability/worker";
import { mapWithConcurrency } from "./bounded-map";
import { renewDeliveryLeaseBeforeSend } from "./integration-delivery-lease";
import {
  deliverySendSignal,
  type IntegrationDeliveryDispatchPolicy,
} from "./integration-delivery-limits";
import { decryptIntegrationSecret, signIntegrationPayload } from "./integration-secret";
import { buildIntegrationSnapshot } from "./integration-snapshot";
import { postWebhook, retryDelayMs } from "./webhook-transport";

const FIRST_SETUP_WINDOW_MS = 10 * 60_000;
// Keep route propagation retries within the CLI first-setup wait window.
const FIRST_SETUP_RETRY_MS = 30_000;

export interface CloudflareDispatchSummary {
  claimed: number;
  received2xx: number;
  receiverRejected: number;
  transportFailures: number;
  preparationFailures: number;
  skippedLeaseLost: number;
}

export interface CloudflarePushDispatchDeps {
  repo: Repository;
  secretKek?: string;
  secretKeyVersion?: string;
  fetcher?: typeof fetch;
  policy: IntegrationDeliveryDispatchPolicy;
  leaseOwner?: () => string;
  scope?: TenantScope;
  onDispatch?: (summary: CloudflareDispatchSummary) => void;
}

export async function dispatchCloudflarePushes(deps: CloudflarePushDispatchDeps): Promise<number> {
  const now = deps.policy.clock.now();
  const leaseOwner = (deps.leaseOwner ?? (() => crypto.randomUUID()))();
  const leaseExpiresAt = now.getTime() + deps.policy.leaseMs;
  const deliveries = await deps.repo.cloudflare.claimDueDeliveries(
    now.toISOString(),
    leaseOwner,
    new Date(leaseExpiresAt).toISOString(),
    deps.policy.claimLimit,
    deps.scope,
  );
  const snapshots = new Map<string, ReturnType<typeof buildStableSnapshot>>();
  const summary: CloudflareDispatchSummary = {
    claimed: deliveries.length,
    received2xx: 0,
    receiverRejected: 0,
    transportFailures: 0,
    preparationFailures: 0,
    skippedLeaseLost: 0,
  };
  const settled = await mapWithConcurrency(deliveries, deps.policy.concurrency, (delivery) =>
    deliverSafely(deps, { ...delivery, leaseExpiresAt }, leaseOwner, now, snapshots, summary).then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
  );
  deps.onDispatch?.(summary);
  const rejected = settled.filter((result) => result.status === "rejected");
  if (rejected.length > 0)
    throw new AggregateError(
      rejected.map((result) => result.reason),
      `${rejected.length} Cloudflare delivery lease updates failed`,
    );
  return deliveries.length;
}

type ClaimedDelivery = Awaited<
  ReturnType<Repository["cloudflare"]["claimDueDeliveries"]>
>[number] & {
  leaseExpiresAt: number;
};
type Delivery = ClaimedDelivery & { firstSetup: boolean };

async function deliverSafely(
  deps: CloudflarePushDispatchDeps,
  claimed: ClaimedDelivery,
  leaseOwner: string,
  now: Date,
  snapshots: Map<string, ReturnType<typeof buildStableSnapshot>>,
  summary: CloudflareDispatchSummary,
): Promise<void> {
  // Outside the try, so a malformed registration time fails the run before anything is sent.
  const delivery = { ...claimed, firstSetup: inFirstSetupWindow(claimed, now) };
  try {
    await deliverOne(deps, delivery, leaseOwner, now, snapshots, summary);
  } catch (cause) {
    summary.preparationFailures += 1;
    console.error("cloudflare_push_delivery_preparation_failed", {
      deliveryId: delivery.deliveryId,
      cause: serializeFault(cause),
    });
    await finishFailure(deps, delivery, leaseOwner, now, true, {
      kind: "internal",
      code: "DELIVERY_PREPARATION_FAILED",
      causeName: cause instanceof Error ? cause.name : "UnknownError",
      occurredAt: now.toISOString(),
    });
  }
}

async function deliverOne(
  deps: CloudflarePushDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
  snapshots: Map<string, ReturnType<typeof buildStableSnapshot>>,
  summary: CloudflareDispatchSummary,
): Promise<void> {
  const snapshot = await snapshotForDelivery(deps.repo, delivery, snapshots);
  const body = JSON.stringify(snapshot);
  const secret = await decryptIntegrationSecret(
    delivery.secretCiphertext,
    deps.secretKek,
    delivery.secretKeyVersion,
    deps.secretKeyVersion,
    "INTEGRATION_SECRET_KEK",
  );
  const timestamp = Math.floor(now.getTime() / 1_000).toString();
  const signature = await signIntegrationPayload(
    secret,
    `${timestamp}.${delivery.deliveryId}.${body}`,
  );
  if (
    !(await renewDeliveryLeaseBeforeSend(
      delivery,
      leaseOwner,
      deps.policy,
      deps.repo.cloudflare.renewDeliveryLease,
    ))
  ) {
    summary.skippedLeaseLost += 1;
    return;
  }
  const result = await postWebhook({
    url: delivery.endpoint,
    body,
    headers: {
      "content-type": "application/json",
      "splitch-delivery-id": delivery.deliveryId,
      "splitch-signature": `v1=${signature}`,
      "splitch-timestamp": timestamp,
    },
    fetcher: deps.fetcher,
    signal: deliverySendSignal(deps.policy.sendTimeoutMs),
  });
  now = deps.policy.clock.outcomeTime(now);
  if (result.outcome === "transport-failed") {
    summary.transportFailures += 1;
    await finishFailure(deps, delivery, leaseOwner, now, true, {
      kind: "transport",
      code: result.cause instanceof Error ? result.cause.name : "UnknownError",
      occurredAt: now.toISOString(),
    });
    return;
  }
  if (result.outcome === "delivered") {
    summary.received2xx += 1;
    const appliedVersion = Number(result.response.headers.get("splitch-environment-version"));
    if (!Number.isInteger(appliedVersion) || appliedVersion < delivery.environmentVersion) {
      await finishFailure(deps, delivery, leaseOwner, now, true, {
        kind: "protocol",
        code: "VERSION_NOT_CONFIRMED",
        occurredAt: now.toISOString(),
      });
      return;
    }
    await deps.repo.cloudflare.finishDelivery(delivery.deliveryId, leaseOwner, {
      state: "delivered",
      now: now.toISOString(),
      appliedVersion,
    });
    return;
  }
  summary.receiverRejected += 1;
  const awaitingRoute = result.status === 404 && delivery.firstSetup;
  await finishFailure(deps, delivery, leaseOwner, now, result.retryable || awaitingRoute, {
    kind: "http",
    code: "HTTP_STATUS",
    httpStatus: result.status,
    occurredAt: now.toISOString(),
  });
}

/**
 * A just-created workers.dev hostname answers Cloudflare's own 404 until its
 * route propagates, and this push can run in a colo that still caches the 404
 * of a Worker deleted moments before, minutes after the CLI's colo saw the new
 * route. Until an installation first applies a version, and only within the
 * window after its registration, a 404 reads as that lag and every retry runs
 * after 30 seconds. The CLI waits out the same window.
 */
function inFirstSetupWindow(delivery: ClaimedDelivery, now: Date): boolean {
  if (delivery.lastAppliedVersion !== null) return false;
  const registeredAt = Date.parse(delivery.registeredAt);
  if (!Number.isFinite(registeredAt))
    throw new Error(
      `Cloudflare installation registeredAt is not a timestamp: ${delivery.registeredAt}`,
    );
  return now.getTime() - registeredAt < FIRST_SETUP_WINDOW_MS;
}

async function buildStableSnapshot(repo: Repository, scope: ReturnType<typeof envScope>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const version = await repo.cloudflare.environmentVersion(scope);
    const snapshot = await buildIntegrationSnapshot(repo, scope, version);
    if ((await repo.cloudflare.environmentVersion(scope)) === version) return snapshot;
  }
  throw new Error("Cloudflare configuration changed repeatedly while building a push snapshot");
}

function snapshotForDelivery(
  repo: Repository,
  delivery: Delivery,
  snapshots: Map<string, ReturnType<typeof buildStableSnapshot>>,
) {
  const key = `${delivery.appId}\0${delivery.environmentId}`;
  let snapshot = snapshots.get(key);
  if (!snapshot) {
    snapshot = buildStableSnapshot(repo, envScope(delivery.appId, delivery.environmentId));
    snapshots.set(key, snapshot);
  }
  return snapshot;
}

async function finishFailure(
  deps: CloudflarePushDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
  retryable: boolean,
  error: Record<string, unknown>,
): Promise<void> {
  const delay = delivery.firstSetup ? FIRST_SETUP_RETRY_MS : retryDelayMs(delivery.attemptCount);
  await deps.repo.cloudflare.finishDelivery(delivery.deliveryId, leaseOwner, {
    state: retryable ? "pending" : "terminal",
    now: now.toISOString(),
    ...(retryable ? { nextAttemptAt: new Date(now.getTime() + delay).toISOString() } : {}),
    errorJson: JSON.stringify(error),
  });
}
