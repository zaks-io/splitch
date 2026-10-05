import type { Repository } from "@splitch/db";
import { decryptConvexSecret, signConvexWebhook } from "./convex-secret";
import { validateIntegrationSecretKey } from "./integration-secret";
import { describeCause, postWebhook, retryDelayMs, type WebhookPost } from "./webhook-transport";

const LEASE_MS = 30_000;
const BATCH_SIZE = 25;
const PREPARATION_RETRY_MS = 30 * 60_000;

interface ConvexDispatchSummary {
  claimed: number;
  received2xx: number;
  receiverRejected: number;
  transportFailures: number;
  preparationFailedInstallations: number;
}

export interface ConvexWebhookDispatchDeps {
  repo: Repository;
  webhookKek?: string;
  webhookKeyVersion?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  leaseOwner?: () => string;
  onDispatch?: (summary: ConvexDispatchSummary) => void;
}

export async function dispatchConvexWebhooks(deps: ConvexWebhookDispatchDeps): Promise<number> {
  validateIntegrationSecretKey(deps.webhookKek, "CONVEX_WEBHOOK_KEK");
  const now = (deps.now ?? (() => new Date()))();
  const leaseOwner = (deps.leaseOwner ?? (() => crypto.randomUUID()))();
  const deliveries = await deps.repo.convex.claimDueDeliveries(
    now.toISOString(),
    leaseOwner,
    new Date(now.getTime() + LEASE_MS).toISOString(),
    BATCH_SIZE,
  );

  const secrets = new Map<string, Promise<string>>();
  const failures = new Map<string, Promise<void>>();
  const summary: ConvexDispatchSummary = {
    claimed: deliveries.length,
    received2xx: 0,
    receiverRejected: 0,
    transportFailures: 0,
    preparationFailedInstallations: 0,
  };
  const settled = await Promise.allSettled(
    deliveries.map((delivery) =>
      deliverSafely(deps, delivery, leaseOwner, now, secrets, failures, summary),
    ),
  );
  deps.onDispatch?.(summary);
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
  secrets: Map<string, Promise<string>>,
  failures: Map<string, Promise<void>>,
  summary: ConvexDispatchSummary,
): Promise<void> {
  let webhook: WebhookPost;
  try {
    let prepared = secrets.get(delivery.installationId);
    if (!prepared) {
      prepared = decryptConvexSecret(
        delivery.secretCiphertext,
        deps.webhookKek,
        delivery.secretKeyVersion,
        deps.webhookKeyVersion,
      );
      secrets.set(delivery.installationId, prepared);
    }
    webhook = await prepareWebhook(delivery, now, await prepared, deps.fetcher);
  } catch (cause) {
    let failure = failures.get(delivery.installationId);
    if (!failure) {
      const causeName = preparationCauseName(cause);
      console.error("convex_webhook_delivery_preparation_failed", {
        installationId: delivery.installationId,
        deliveryId: delivery.deliveryId,
        code: "DELIVERY_PREPARATION_FAILED",
        causeName,
      });
      summary.preparationFailedInstallations += 1;
      failure = deps.repo.convex.deferPreparationFailure(delivery.installationId, leaseOwner, {
        secretCiphertext: delivery.secretCiphertext,
        secretKeyVersion: delivery.secretKeyVersion,
        now: now.toISOString(),
        retryAt: new Date(now.getTime() + PREPARATION_RETRY_MS).toISOString(),
        errorJson: JSON.stringify({
          kind: "internal",
          code: "DELIVERY_PREPARATION_FAILED",
          occurredAt: now.toISOString(),
        }),
      });
      failures.set(delivery.installationId, failure);
    }
    await failure;
    return;
  }
  await deliverOne(deps, delivery, leaseOwner, now, webhook, summary);
}

async function prepareWebhook(
  delivery: Delivery,
  now: Date,
  secret: string,
  fetcher?: typeof fetch,
): Promise<WebhookPost> {
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
    fetcher,
  };
}

async function deliverOne(
  deps: ConvexWebhookDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
  webhook: WebhookPost,
  summary: ConvexDispatchSummary,
): Promise<void> {
  const result = await postWebhook(webhook);

  if (result.outcome === "transport-failed") {
    summary.transportFailures += 1;
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
    summary.received2xx += 1;
    await deps.repo.convex.finishDelivery(delivery.deliveryId, leaseOwner, {
      state: "delivered",
      now: now.toISOString(),
    });
    return;
  }

  summary.receiverRejected += 1;
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

function preparationCauseName(cause: unknown): string {
  return cause instanceof Error &&
    ["Error", "OperationError", "DataError", "InvalidCharacterError", "TypeError"].includes(
      cause.name,
    )
    ? cause.name
    : "UnknownError";
}
