import type { Repository } from "@splitch/db";
import { envScope } from "@splitch/db";
import { decryptIntegrationSecret, signIntegrationPayload } from "./integration-secret";
import { buildIntegrationSnapshot } from "./integration-snapshot";

const LEASE_MS = 30_000;
const BATCH_SIZE = 25;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000] as const;

export interface CloudflarePushDispatchDeps {
  repo: Repository;
  secretKek?: string;
  secretKeyVersion?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  leaseOwner?: () => string;
}

export async function dispatchCloudflarePushes(deps: CloudflarePushDispatchDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const leaseOwner = (deps.leaseOwner ?? (() => crypto.randomUUID()))();
  const deliveries = await deps.repo.cloudflare.claimDueDeliveries(
    now.toISOString(),
    leaseOwner,
    new Date(now.getTime() + LEASE_MS).toISOString(),
    BATCH_SIZE,
  );
  const snapshots = new Map<string, ReturnType<typeof buildStableSnapshot>>();
  const settled = await Promise.allSettled(
    deliveries.map((delivery) => deliverSafely(deps, delivery, leaseOwner, now, snapshots)),
  );
  const rejected = settled.filter((result) => result.status === "rejected");
  if (rejected.length > 0)
    throw new AggregateError(
      rejected.map((result) => result.reason),
      `${rejected.length} Cloudflare delivery lease updates failed`,
    );
  return deliveries.length;
}

type Delivery = Awaited<ReturnType<Repository["cloudflare"]["claimDueDeliveries"]>>[number];

async function deliverSafely(
  deps: CloudflarePushDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
  snapshots: Map<string, ReturnType<typeof buildStableSnapshot>>,
): Promise<void> {
  try {
    await deliverOne(deps, delivery, leaseOwner, now, snapshots);
  } catch (cause) {
    console.error("cloudflare_push_delivery_preparation_failed", {
      deliveryId: delivery.deliveryId,
      cause:
        cause instanceof Error
          ? { name: cause.name, message: cause.message, stack: cause.stack }
          : String(cause),
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
): Promise<void> {
  const scope = envScope(delivery.appId, delivery.environmentId);
  const snapshotKey = `${delivery.appId}\0${delivery.environmentId}`;
  let snapshotPromise = snapshots.get(snapshotKey);
  if (!snapshotPromise) {
    snapshotPromise = buildStableSnapshot(deps.repo, scope);
    snapshots.set(snapshotKey, snapshotPromise);
  }
  const snapshot = await snapshotPromise;
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
  let response: Response;
  try {
    response = await (deps.fetcher ?? fetch)(delivery.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "splitch-delivery-id": delivery.deliveryId,
        "splitch-signature": `v1=${signature}`,
        "splitch-timestamp": timestamp,
      },
      body,
      redirect: "manual",
    });
  } catch (cause) {
    await finishFailure(deps, delivery, leaseOwner, now, true, {
      kind: "transport",
      code: cause instanceof Error ? cause.name : "UnknownError",
      occurredAt: now.toISOString(),
    });
    return;
  }
  if (response.ok) {
    const appliedVersion = Number(response.headers.get("splitch-environment-version"));
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
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  await finishFailure(deps, delivery, leaseOwner, now, retryable, {
    kind: "http",
    code: "HTTP_STATUS",
    httpStatus: response.status,
    occurredAt: now.toISOString(),
  });
}

async function buildStableSnapshot(repo: Repository, scope: ReturnType<typeof envScope>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const version = await repo.cloudflare.environmentVersion(scope);
    const snapshot = await buildIntegrationSnapshot(repo, scope, version);
    if ((await repo.cloudflare.environmentVersion(scope)) === version) return snapshot;
  }
  throw new Error("Cloudflare configuration changed repeatedly while building a push snapshot");
}

async function finishFailure(
  deps: CloudflarePushDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
  retryable: boolean,
  error: Record<string, unknown>,
): Promise<void> {
  const delay =
    RETRY_DELAYS_MS[Math.min(delivery.attemptCount, RETRY_DELAYS_MS.length - 1)] ?? 1_800_000;
  await deps.repo.cloudflare.finishDelivery(delivery.deliveryId, leaseOwner, {
    state: retryable ? "pending" : "terminal",
    now: now.toISOString(),
    ...(retryable ? { nextAttemptAt: new Date(now.getTime() + delay).toISOString() } : {}),
    errorJson: JSON.stringify(error),
  });
}
