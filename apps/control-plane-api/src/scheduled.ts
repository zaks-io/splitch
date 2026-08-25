import { createRepository } from "@splitch/db";
import {
  createWorkerFaultReporter,
  workerEmitter,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import { runApprovalRequestArchival } from "./approval-archive";
import { approvalArchiveStoreFromEnv } from "./approval-archive-tinybird";
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
  if (event.cron !== "0 8 * * *") return;
  ctx.waitUntil(runDemoReaper(env, event, ctx));
  ctx.waitUntil(runCredentialCacheBackfill(env));
  ctx.waitUntil(runApprovalArchive(env, event, ctx));
}

async function runConvexWebhookDispatch(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const dispatched = await dispatchConvexWebhooks({
    repo: createRepository(env.DB),
    webhookKek: env.CONVEX_WEBHOOK_KEK,
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
