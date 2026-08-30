import type { Repository } from "@splitch/db";
import { decryptConvexSecret, signConvexWebhook } from "./convex-secret";
import { describeCause, postWebhook, retryDelayMs, type WebhookPost } from "./webhook-transport";

const LEASE_MS = 30_000;
const BATCH_SIZE = 25;

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

  const settled = await Promise.allSettled(
    deliveries.map((delivery) => deliverSafely(deps, delivery, leaseOwner, now)),
  );
  const rejected = settled.filter((result) => result.status === "rejected");
  if (rejected.length > 0)
    throw new AggregateError(
      rejected.map((result) => result.reason),
      `${rejected.length} Convex delivery lease updates failed`,
    );
  return deliveries.length;
}

type Delivery = Awaited<ReturnType<Repository["convex"]["claimDueDeliveries"]>>[number];

async function deliverSafely(
  deps: ConvexWebhookDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
): Promise<void> {
  let webhook: WebhookPost;
  try {
    webhook = await prepareWebhook(deps, delivery, now);
  } catch (cause) {
    console.error("convex_webhook_delivery_preparation_failed", {
      deliveryId: delivery.deliveryId,
      cause: describeCause(cause),
    });
    await finishFailure(deps, delivery, leaseOwner, now, true, {
      kind: "internal",
      code: "DELIVERY_PREPARATION_FAILED",
      occurredAt: now.toISOString(),
    });
    return;
  }
  await deliverOne(deps, delivery, leaseOwner, now, webhook);
}

async function prepareWebhook(
  deps: ConvexWebhookDispatchDeps,
  delivery: Delivery,
  now: Date,
): Promise<WebhookPost> {
  const secret = await decryptConvexSecret(
    delivery.secretCiphertext,
    deps.webhookKek,
    delivery.secretKeyVersion,
    deps.webhookKeyVersion,
  );
  const timestamp = Math.floor(now.getTime() / 1_000).toString();
  const signature = await signConvexWebhook(secret, timestamp, delivery.bodyJson);
  return {
    url: delivery.callbackUrl,
    body: delivery.bodyJson,
    headers: {
      "content-type": "application/json",
      "splitch-delivery-id": delivery.deliveryId,
      "splitch-signature": `v1=${signature}`,
      "splitch-timestamp": timestamp,
    },
    fetcher: deps.fetcher,
  };
}

async function deliverOne(
  deps: ConvexWebhookDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
  webhook: WebhookPost,
): Promise<void> {
  const result = await postWebhook(webhook);

  if (result.outcome === "transport-failed") {
    console.error("convex_webhook_delivery_transport_failed", {
      deliveryId: delivery.deliveryId,
      callbackUrl: delivery.callbackUrl,
      cause: describeCause(result.cause),
    });
    await finishFailure(deps, delivery, leaseOwner, now, true, {
      kind: "transport",
      code: "CONNECT_TIMEOUT",
      occurredAt: now.toISOString(),
    });
    return;
  }

  if (result.outcome === "delivered") {
    await deps.repo.convex.finishDelivery(delivery.deliveryId, leaseOwner, {
      state: "delivered",
      now: now.toISOString(),
    });
    return;
  }

  await finishFailure(deps, delivery, leaseOwner, now, result.retryable, {
    kind: "http",
    code: "HTTP_STATUS",
    httpStatus: result.status,
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
  const retryDelay = retryDelayMs(delivery.attemptCount);
  await deps.repo.convex.finishDelivery(delivery.deliveryId, leaseOwner, {
    state: retryable ? "pending" : "terminal",
    now: now.toISOString(),
    ...(retryable ? { nextAttemptAt: new Date(now.getTime() + retryDelay).toISOString() } : {}),
    errorJson: JSON.stringify(error),
  });
}
