import type { EnvScope, Repository } from "@splitch/db";
import { serializeFault } from "@splitch/observability/worker";
import { mapWithConcurrency } from "./bounded-map";
import {
  configurationCallbackDestinationError,
  postConfigurationCallback,
} from "./configuration-callback-transport";
import {
  type ConvexDeploymentProbeCandidate,
  probeMissingConvexDeployments,
} from "./convex-deployments";
import { decryptConvexSecret, signConvexWebhook } from "./convex-secret";
import type { IntegrationDeliveryDispatchPolicy } from "./integration-delivery-limits";
import { renewDeliveryLeaseBeforeSend } from "./integration-delivery-lease";
import { validateIntegrationSecretKey } from "./integration-secret";
import { retryDelayMs, type WebhookPost } from "./webhook-transport";

const PREPARATION_RETRY_MS = 30 * 60_000;

export interface ConvexDispatchSummary {
  claimed: number;
  received2xx: number;
  receiverRejected: number;
  transportFailures: number;
  preparationFailedInstallations: number;
  skippedLeaseLost: number;
}

export interface ConvexWebhookDispatchDeps {
  repo: Repository;
  scope?: EnvScope;
  webhookKek?: string;
  webhookKeyVersion?: string;
  fetcher?: typeof fetch;
  policy: IntegrationDeliveryDispatchPolicy;
  leaseOwner?: () => string;
  onDispatch?: (summary: ConvexDispatchSummary) => void;
}

export async function dispatchConvexWebhooks(deps: ConvexWebhookDispatchDeps): Promise<number> {
  validateIntegrationSecretKey(deps.webhookKek, "CONVEX_WEBHOOK_KEK");
  const now = deps.policy.clock.now();
  const leaseOwner = (deps.leaseOwner ?? (() => crypto.randomUUID()))();
  const leaseExpiresAt = now.getTime() + deps.policy.leaseMs;
  const deliveries = await deps.repo.convex.claimDueDeliveries(
    now.toISOString(),
    leaseOwner,
    new Date(leaseExpiresAt).toISOString(),
    deps.policy.claimLimit,
    deps.scope,
  );

  const secrets = new Map<string, Promise<string>>();
  const failures = new Map<string, Promise<void>>();
  const summary: ConvexDispatchSummary = {
    claimed: deliveries.length,
    received2xx: 0,
    receiverRejected: 0,
    transportFailures: 0,
    preparationFailedInstallations: 0,
    skippedLeaseLost: 0,
  };
  const settled = await mapWithConcurrency(deliveries, deps.policy.concurrency, (delivery) =>
    deliverSafely(
      deps,
      { ...delivery, leaseExpiresAt },
      leaseOwner,
      now,
      secrets,
      failures,
      summary,
    ).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
  );
  // Fulfilled values carry lifecycle generations, so policy scheduling must preserve them.
  await probeMissingConvexDeployments(deps, settled);
  deps.onDispatch?.(summary);
  const rejected = settled.filter((result) => result.status === "rejected");
  if (rejected.length > 0)
    throw new AggregateError(
      rejected.map((result) => result.reason),
      `${rejected.length} Convex delivery lease updates failed`,
    );
  return deliveries.length;
}

type Delivery = Awaited<ReturnType<Repository["convex"]["claimDueDeliveries"]>>[number] & {
  leaseExpiresAt: number;
};

async function deliverSafely(
  deps: ConvexWebhookDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
  secrets: Map<string, Promise<string>>,
  failures: Map<string, Promise<void>>,
  summary: ConvexDispatchSummary,
): Promise<ConvexDeploymentProbeCandidate | undefined> {
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
      console.error("convex_webhook_delivery_preparation_failed", {
        installationId: delivery.installationId,
        deliveryId: delivery.deliveryId,
        code: "DELIVERY_PREPARATION_FAILED",
        cause: serializeFault(cause),
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
  return deliverOne(deps, delivery, leaseOwner, now, webhook, summary);
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
): Promise<ConvexDeploymentProbeCandidate | undefined> {
  const destinationError = configurationCallbackDestinationError(webhook.url);
  if (destinationError) {
    summary.receiverRejected += 1;
    await finishFailure(deps, delivery, leaseOwner, now, false, {
      kind: "internal",
      code: "CALLBACK_DESTINATION_REJECTED",
      occurredAt: now.toISOString(),
    });
    return;
  }
  if (
    !(await renewDeliveryLeaseBeforeSend(
      delivery,
      leaseOwner,
      deps.policy,
      deps.repo.convex.renewDeliveryLease,
    ))
  ) {
    summary.skippedLeaseLost += 1;
    return;
  }
  const result = await postConfigurationCallback(webhook, deps.policy.sendTimeoutMs);
  now = deps.policy.clock.outcomeTime(now);

  if (result.outcome === "transport-failed") {
    summary.transportFailures += 1;
    console.error("convex_webhook_delivery_transport_failed", {
      deliveryId: delivery.deliveryId,
      callbackUrl: delivery.callbackUrl,
      cause: serializeFault(result.cause),
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
  const probeToken = await finishFailure(deps, delivery, leaseOwner, now, result.retryable, {
    kind: "http",
    code: "HTTP_STATUS",
    httpStatus: result.status,
    occurredAt: now.toISOString(),
  });
  if (result.status === 404 && probeToken)
    return {
      installationId: delivery.installationId,
      callbackUrl: delivery.callbackUrl,
      probeToken,
      failedAt: now,
    };
  return;
}

async function finishFailure(
  deps: ConvexWebhookDispatchDeps,
  delivery: Delivery,
  leaseOwner: string,
  now: Date,
  retryable: boolean,
  error: Record<string, unknown>,
): Promise<string | null> {
  const retryDelay = retryDelayMs(delivery.attemptCount);
  return deps.repo.convex.finishDelivery(delivery.deliveryId, leaseOwner, {
    state: retryable ? "pending" : "terminal",
    now: now.toISOString(),
    ...(retryable ? { nextAttemptAt: new Date(now.getTime() + retryDelay).toISOString() } : {}),
    errorJson: JSON.stringify(error),
  });
}
