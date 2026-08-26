import type { Repository, SentryInstallationRow } from "@splitch/db";
import { decryptIntegrationSecret, signIntegrationPayload } from "./integration-secret";
import { sentryFlagLogBody, unattributedSeqs } from "./sentry-change-payload";
import { sentryWebhookUrlError } from "./sentry-webhook-url";
import { describeCause, postWebhook, retryDelayMs } from "./webhook-transport";

/**
 * Pushes the flag-change log to Sentry's Generic Flag Log endpoint so an issue
 * can be correlated with the flag change that preceded it.
 *
 * No outbox and no lease, unlike the Convex dispatcher: `flag_change_events.seq`
 * is monotonic and Sentry treats `change_id` as an idempotency token, so the
 * installation's `last_delivered_seq` is the whole delivery state and a
 * redelivered batch is a no-op on Sentry's side.
 */

const INSTALLATION_BATCH = 25;
const EVENT_BATCH = 100;

export interface SentryWebhookDispatchDeps {
  repo: Repository;
  secretKek?: string;
  secretKeyVersion?: string;
  allowedHosts?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
}

/** Number of change events accepted by Sentry across all installations. */
export async function dispatchSentryWebhooks(deps: SentryWebhookDispatchDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const installations = await deps.repo.sentry.dueInstallations(
    now.toISOString(),
    INSTALLATION_BATCH,
  );
  const delivered = await Promise.all(
    installations.map((installation) => deliverIsolated(deps, installation, now)),
  );
  return delivered.reduce((total, count) => total + count, 0);
}

/**
 * One installation's fault must not take the batch with it. A KEK-version
 * mismatch or a malformed stored row throws out of `deliverOne`, and an
 * unguarded `Promise.all` would reject the whole tick: every other
 * installation's cursor stays put, no failure is recorded anywhere, and the
 * same throw repeats every minute with nothing to see it. Recording the fault
 * against the offending installation puts it in `attempt_count` and
 * `latest_delivery_error_json`, where an operator reads it.
 */
async function deliverIsolated(
  deps: SentryWebhookDispatchDeps,
  installation: SentryInstallationRow,
  now: Date,
): Promise<number> {
  try {
    return await deliverOne(deps, installation, now);
  } catch (cause) {
    console.error("sentry_webhook_delivery_failed", {
      installationId: installation.installationId,
      cause: describeCause(cause),
    });
    await recordFailure(deps, installation, now, {
      kind: "internal",
      code: "DISPATCH_FAILED",
      cause: describeCause(cause),
    });
    return 0;
  }
}

async function deliverOne(
  deps: SentryWebhookDispatchDeps,
  installation: SentryInstallationRow,
  now: Date,
): Promise<number> {
  // Re-validated per dispatch, not just at install time: this Worker POSTs
  // unattended from inside Cloudflare's network, and the row outlives the
  // request that created it.
  const urlError = sentryWebhookUrlError(installation.webhookUrl, {
    allowedHosts: deps.allowedHosts,
  });
  if (urlError) {
    console.error("sentry_webhook_url_rejected", {
      installationId: installation.installationId,
      reason: urlError,
    });
    await recordFailure(deps, installation, now, { kind: "config", code: "URL_REJECTED" });
    return 0;
  }

  const events = await deps.repo.flagChangeEvents.pendingForScope(
    installation.appId,
    installation.environmentId,
    installation.lastDeliveredSeq ?? 0,
    EVENT_BATCH,
  );
  // Nothing pending is not a delivery: writing a success here would reset the
  // backoff of an installation that has never actually reached Sentry.
  if (events.length === 0) return 0;

  const unattributed = unattributedSeqs(events);
  if (unattributed.length > 0) {
    console.warn("sentry_webhook_unattributed_changes", {
      installationId: installation.installationId,
      count: unattributed.length,
      seqs: unattributed,
    });
  }

  const body = JSON.stringify(sentryFlagLogBody(events));
  const secret = await decryptIntegrationSecret(
    installation.secretCiphertext,
    deps.secretKek,
    installation.secretKeyVersion,
    deps.secretKeyVersion,
    "INTEGRATION_SECRET_KEK",
  );
  const result = await postWebhook({
    url: installation.webhookUrl,
    body,
    headers: {
      "content-type": "application/json",
      // Sentry verifies a bare hex digest over the raw body: no timestamp and
      // no `v1=` prefix, unlike splitch's own webhook scheme.
      "x-sentry-signature": await signIntegrationPayload(secret, body),
    },
    fetcher: deps.fetcher,
  });

  if (result.outcome === "delivered") {
    const highest = events.at(-1)?.seq;
    if (highest === undefined) throw new Error("sentry dispatch: delivered an empty batch");
    await deps.repo.sentry.recordSuccess(installation.installationId, highest, now.toISOString());
    return events.length;
  }

  if (result.outcome === "transport-failed") {
    console.error("sentry_webhook_delivery_transport_failed", {
      installationId: installation.installationId,
      cause: describeCause(result.cause),
    });
    await recordFailure(deps, installation, now, {
      kind: "transport",
      code: "CONNECT_FAILED",
    });
    return 0;
  }

  // The cursor is deliberately untouched on rejection, retryable or not: a 400
  // means Sentry refused this exact batch, and skipping past it would drop the
  // changes silently instead of leaving them visible in `attempt_count`.
  await recordFailure(deps, installation, now, {
    kind: "http",
    code: "HTTP_STATUS",
    httpStatus: result.status,
  });
  return 0;
}

async function recordFailure(
  deps: SentryWebhookDispatchDeps,
  installation: SentryInstallationRow,
  now: Date,
  error: Record<string, unknown>,
): Promise<void> {
  const retryDelay = retryDelayMs(installation.attemptCount);
  await deps.repo.sentry.recordFailure(installation.installationId, {
    nextAttemptAt: new Date(now.getTime() + retryDelay).toISOString(),
    errorJson: JSON.stringify({ ...error, occurredAt: now.toISOString() }),
    now: now.toISOString(),
  });
}
