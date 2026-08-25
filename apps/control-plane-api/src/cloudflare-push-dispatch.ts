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
  await Promise.all(deliveries.map((delivery) => deliverOne(deps, delivery, leaseOwner, now)));
  return deliveries.length;
}

type Delivery = Awaited<ReturnType<Repository["cloudflare"]["claimDueDeliveries"]>>[number];

async function deliverOne(
  deps: CloudflarePushDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
): Promise<void> {
  const scope = envScope(delivery.appId, delivery.environmentId);
  const snapshot = await buildStableSnapshot(deps.repo, scope);
  const body = JSON.stringify(snapshot);
  const secret = await decryptIntegrationSecret(
    delivery.secretCiphertext,
    deps.secretKek,
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
  } catch {
    await finishFailure(deps, delivery, leaseOwner, now, true, {
      kind: "transport",
      code: "CONNECT_TIMEOUT",
      occurredAt: now.toISOString(),
    });
    return;
  }
  if (response.ok) {
    const appliedVersion = Number(response.headers.get("splitch-environment-version"));
    if (!Number.isInteger(appliedVersion) || appliedVersion < delivery.environmentVersion) {
      await finishFailure(deps, delivery, leaseOwner, now, true, {
        kind: "http",
        code: "HTTP_STATUS",
        httpStatus: response.status,
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
