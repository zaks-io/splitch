import { createRepository } from "@splitch/db";
import {
  createWorkerFaultReporter,
  workerEmitter,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import { runApprovalRequestArchival } from "./approval-archive";
import { approvalArchiveStoreFromEnv } from "./approval-archive-tinybird";
import { dispatchCloudflarePushes } from "./cloudflare-push-dispatch";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";
import type { ControlPlaneApiEnv } from "./env";
import { runCredentialCacheBackfill } from "./internal-routes";
import {
  makeMembershipCacheInvalidator,
  mutateMembershipWithCacheInvalidation,
} from "./membership-cache";
import { dispatchSentryWebhooks } from "./sentry-webhook-dispatch";

const service = "splitch-control-plane-api";

export function runControlPlaneScheduled(
  event: ScheduledController,
  env: ControlPlaneApiEnv,
  ctx: ExecutionContext,
): void {
  // Integration delivery belongs to the minute cron alone. Running it on every
  // tick would fire a second concurrent dispatch at 08:00, when both crons
  // land: the Convex and Cloudflare paths lease their deliveries and would
  // survive it, but the Sentry cursor has no lease to protect it.
  if (event.cron !== "0 8 * * *") {
    ctx.waitUntil(runConvexWebhookDispatch(env, event, ctx));
    ctx.waitUntil(runCloudflarePushDispatch(env, event, ctx));
    ctx.waitUntil(runSentryWebhookDispatch(env, event, ctx));
    return;
  }
  ctx.waitUntil(runDemoReaper(env, event, ctx));
  ctx.waitUntil(runCredentialCacheBackfill(env));
  ctx.waitUntil(runApprovalArchive(env, event, ctx));
  ctx.waitUntil(runFlagChangeLogRetention(env, event, ctx));
}

async function runCloudflarePushDispatch(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  try {
    const dispatched = await dispatchCloudflarePushes({
      repo: createRepository(env.DB),
      secretKek: env.INTEGRATION_SECRET_KEK,
      secretKeyVersion: env.INTEGRATION_SECRET_KEY_VERSION,
      now: () => new Date(event.scheduledTime),
    });
    workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
      "info",
      "cloudflare-push-dispatch",
      { service, job: "cloudflare-push-dispatch", cron: event.cron, dispatched },
    );
  } catch (error) {
    createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
      "cloudflare_push_dispatch_failed",
      {
        service,
        job: "cloudflare-push-dispatch",
        cron: event.cron,
        fault: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
    );
    throw error;
  }
}

async function runSentryWebhookDispatch(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  try {
    const dispatched = await dispatchSentryWebhooks({
      repo: createRepository(env.DB),
      secretKek: env.INTEGRATION_SECRET_KEK,
      secretKeyVersion: env.INTEGRATION_SECRET_KEY_VERSION,
      allowedHosts: env.SENTRY_WEBHOOK_ALLOWED_HOSTS,
      now: () => new Date(event.scheduledTime),
    });
    workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
      "info",
      "sentry-webhook-dispatch",
      { service, job: "sentry-webhook-dispatch", cron: event.cron, dispatched },
    );
  } catch (error) {
    createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
      "sentry_webhook_dispatch_failed",
      {
        service,
        job: "sentry-webhook-dispatch",
        cron: event.cron,
        fault: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
    );
    throw error;
  }
}

/**
 * The flag-change log is unbounded by construction: triggers write, nothing
 * deletes. Retention prunes rows older than 90 days that every active
 * integration has already consumed.
 *
 * With no active installation the cursor floor is `Number.MAX_SAFE_INTEGER`, so
 * age alone governs. `minUndeliveredSeq()` returning null means exactly that;
 * passing 0 instead would be a silent no-op that let the table grow forever.
 */
async function runFlagChangeLogRetention(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const repo = createRepository(env.DB);
  const scheduled = new Date(event.scheduledTime);
  const cursor = await repo.sentry.minUndeliveredSeq();
  const pruned = await repo.flagChangeEvents.pruneBefore({
    changedBefore: new Date(scheduled.getTime() - RETENTION_MS).toISOString(),
    minUndeliveredSeq: cursor ?? Number.MAX_SAFE_INTEGER,
    limit: RETENTION_BATCH,
  });
  workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
    "info",
    "flag-change-log-retention",
    { service, job: "flag-change-log-retention", cron: event.cron, pruned, cursor },
  );
}

const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const RETENTION_BATCH = 1_000;

async function runConvexWebhookDispatch(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const dispatched = await dispatchConvexWebhooks({
    repo: createRepository(env.DB),
    webhookKek: env.CONVEX_WEBHOOK_KEK,
    webhookKeyVersion: env.CONVEX_WEBHOOK_KEY_VERSION,
    now: () => new Date(event.scheduledTime),
  });
  workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
    "info",
    "convex-webhook-dispatch",
    { service, job: "convex-webhook-dispatch", cron: event.cron, dispatched },
  );
}

async function runDemoReaper(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const now = new Date(event.scheduledTime).toISOString();
  const repo = createRepository(env.DB);
  const affectedUserIds = await repo.identity.listExpiredProvisionalMembershipUserIds(now);
  const result = await mutateMembershipWithCacheInvalidation(
    makeMembershipCacheInvalidator(env.SESSION_STORE),
    affectedUserIds,
    () => repo.identity.reapExpiredProvisionalOrganizations(now),
  );
  const claimArtifacts = await repo.claim.purgeExpiredClaimArtifacts({ now, limit: 100 });
  workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
    "info",
    "demo-reaper",
    {
      service,
      job: "demo-reaper",
      cron: event.cron,
      candidates: result.candidates,
      reaped: result.reaped,
      claimArtifacts,
    },
  );
}

async function runApprovalArchive(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  try {
    const archived = await runApprovalRequestArchival({
      repo: createRepository(env.DB),
      store: approvalArchiveStoreFromEnv(env),
      now: new Date(event.scheduledTime),
    });
    workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
      "info",
      "approval-request-archive",
      { service, job: "approval-request-archive", cron: event.cron, archived },
    );
  } catch (error) {
    createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
      "approval_request_archive_failed",
      {
        service,
        job: "approval-request-archive",
        cron: event.cron,
        fault: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
    );
    throw error;
  }
}
