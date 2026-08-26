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

const service = "splitch-control-plane-api";

export function runControlPlaneScheduled(
  event: ScheduledController,
  env: ControlPlaneApiEnv,
  ctx: ExecutionContext,
): void {
  ctx.waitUntil(runConvexWebhookDispatch(env, event, ctx));
  ctx.waitUntil(runCloudflarePushDispatch(env, event, ctx));
  if (event.cron !== "0 8 * * *") return;
  ctx.waitUntil(runDemoReaper(env, event, ctx));
  ctx.waitUntil(runCredentialCacheBackfill(env));
  ctx.waitUntil(runApprovalArchive(env, event, ctx));
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
  const result = await repo.identity.reapExpiredProvisionalOrganizations(now);
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
