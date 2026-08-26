import type { Repository } from "@splitch/db";
import { decryptConvexSecret, signConvexWebhook } from "./convex-secret";

const LEASE_MS = 30_000;
const BATCH_SIZE = 25;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000] as const;

export interface ConvexWebhookDispatchDeps {
  repo: Repository;
  webhookKek?: string;
  webhookKeyVersion?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  leaseOwner?: () => string;
}

export async function dispatchConvexWebhooks(deps: ConvexWebhookDispatchDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const leaseOwner = (deps.leaseOwner ?? (() => crypto.randomUUID()))();
  const deliveries = await deps.repo.convex.claimDueDeliveries(
    now.toISOString(),
    leaseOwner,
    new Date(now.getTime() + LEASE_MS).toISOString(),
    BATCH_SIZE,
  );

  await Promise.all(deliveries.map((delivery) => deliverOne(deps, delivery, leaseOwner, now)));
  return deliveries.length;
}

type Delivery = Awaited<ReturnType<Repository["convex"]["claimDueDeliveries"]>>[number];

async function deliverOne(
  deps: ConvexWebhookDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
): Promise<void> {
  const secret = await decryptConvexSecret(
    delivery.secretCiphertext,
    deps.webhookKek,
    delivery.secretKeyVersion,
    deps.webhookKeyVersion,
  );
  const timestamp = Math.floor(now.getTime() / 1_000).toString();
  const signature = await signConvexWebhook(secret, timestamp, delivery.bodyJson);
  let response: Response;
  try {
    response = await (deps.fetcher ?? fetch)(delivery.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "splitch-delivery-id": delivery.deliveryId,
        "splitch-signature": `v1=${signature}`,
        "splitch-timestamp": timestamp,
      },
      body: delivery.bodyJson,
      redirect: "manual",
    });
  } catch (cause) {
    console.error("convex_webhook_delivery_transport_failed", {
      deliveryId: delivery.deliveryId,
      callbackUrl: delivery.callbackUrl,
      cause:
        cause instanceof Error
          ? { name: cause.name, message: cause.message, stack: cause.stack }
          : String(cause),
    });
    await finishFailure(deps, delivery, leaseOwner, now, true, {
      kind: "transport",
      code: "CONNECT_TIMEOUT",
      occurredAt: now.toISOString(),
    });
    return;
  }

  if (response.ok) {
    await deps.repo.convex.finishDelivery(delivery.deliveryId, leaseOwner, {
      state: "delivered",
      now: now.toISOString(),
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

async function finishFailure(
  deps: ConvexWebhookDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
  retryable: boolean,
  error: Record<string, unknown>,
): Promise<void> {
  const retryDelay =
    RETRY_DELAYS_MS[Math.min(delivery.attemptCount, RETRY_DELAYS_MS.length - 1)] ?? 1_800_000;
  await deps.repo.convex.finishDelivery(delivery.deliveryId, leaseOwner, {
    state: retryable ? "pending" : "terminal",
    now: now.toISOString(),
    ...(retryable ? { nextAttemptAt: new Date(now.getTime() + retryDelay).toISOString() } : {}),
    errorJson: JSON.stringify(error),
  });
}
