import { cronDeliveryPolicy } from "./integration-delivery-limits";
import { createRepository, type ScheduledDueWork } from "@splitch/db";
import {
  createWorkerFaultReporter,
  serializeFault,
  workerEmitter,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import { runApprovalRequestArchival } from "./approval-archive";
import { approvalArchiveStoreFromEnv } from "./approval-archive-tinybird";
import { forwardAuditEvents } from "./audit-events";
import { dispatchCloudflarePushes } from "./cloudflare-push-dispatch";
import { integrationDeliveryMode } from "./control-plane-runtime-config";
import { runConvexDeploymentReprobes } from "./convex-deployments-scheduled";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";
import { runIntegrationDeliveryLag } from "./integration-delivery-lag";
import { runDeliveryRetention } from "./delivery-retention";
import { purgeExpiredPrivacyArtifacts, reconcilePrivacyJobs } from "./entity-privacy-jobs";
import type { ControlPlaneApiEnv } from "./env";
import { FLAG_CHANGE_LOG_RETENTION_MS } from "./flag-change-log-retention";
import { runIntegrationDeliverySweep } from "./integration-delivery-sweep";
import { runPersonalAccessTokenRetention } from "./personal-access-token-rotation";
import { deleteOrphanedPrivacyExports } from "./privacy-export-cleanup";
import { scheduledDueWork } from "./scheduled-due-work";
import { dispatchSentryWebhooks } from "./sentry-webhook-dispatch";
import { runTemporaryEnvironmentTeardown } from "./temporary-environment-teardown-scheduled";

const service = "splitch-control-plane-api";

export function runControlPlaneScheduled(
  event: ScheduledController,
  env: ControlPlaneApiEnv,
  ctx: ExecutionContext,
): void {
  const mode = integrationDeliveryMode(env);
  const dueWork = scheduledDueWork(env, event, ctx);
  const runIfDue = (job: keyof ScheduledDueWork, run: () => Promise<unknown>) =>
    ctx.waitUntil(dueWork.then((due) => (due[job] ? run() : undefined)));
  runIfDue("privacyReconciliation", () => reconcilePrivacyJobs(env, new Date(event.scheduledTime)));
  runIfDue("privacyArtifactPurge", () =>
    purgeExpiredPrivacyArtifacts(env, new Date(event.scheduledTime)),
  );
  runIfDue("personalAccessTokenRetention", () => runPersonalAccessTokenRetentionJob(env, event));
  // At 08:00 both crons fire; Sentry has no lease against overlapping dispatch.
  if (event.cron !== "0 8 * * *") {
    ctx.waitUntil(runIntegrationDeliveryLag(env, event, ctx));
    runIfDue("temporaryEnvironmentTeardown", () =>
      runTemporaryEnvironmentTeardown(env, event, ctx),
    );
    runIfDue("auditEventForwarding", () => runAuditEventForwarding(env, event, ctx));
    if (mode === "coordinator") {
      ctx.waitUntil(runIntegrationDeliverySweep(env, event, ctx));
    } else {
      runIfDue("convexWebhookDispatch", () => runConvexWebhookDispatch(env, event, ctx));
      runIfDue("cloudflarePushDispatch", () => runCloudflarePushDispatch(env, event, ctx));
    }
    runIfDue("sentryWebhookDispatch", () => runSentryWebhookDispatch(env, event, ctx));
    return;
  }
  ctx.waitUntil(runConvexDeploymentReprobes(env, event, ctx));
  ctx.waitUntil(runDemoReaper(env, event, ctx));
  ctx.waitUntil(runMetricEventClaimRetentionAdoption(env, event, ctx));
  ctx.waitUntil(runApprovalArchive(env, event, ctx));
  ctx.waitUntil(runFlagChangeLogRetention(env, event, ctx));
  ctx.waitUntil(runDeliveryRetention(env, event, ctx));
  ctx.waitUntil(runAuditEventRetention(env, event, ctx));
}

async function runPersonalAccessTokenRetentionJob(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
): Promise<void> {
  await runPersonalAccessTokenRetention(
    createRepository(env.DB).personalAccessTokens,
    env.SESSION_STORE,
    event.scheduledTime,
  );
}

async function runAuditEventForwarding(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  try {
    await forwardAuditEvents({ repo: createRepository(env.DB), env });
  } catch (error) {
    createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
      "audit_event_forward_failed",
      { service, job: "audit-event-forward", cron: event.cron, fault: serializeFault(error) },
    );
    throw new Error("audit_event_forward_failed");
  }
}

async function runAuditEventRetention(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  try {
    const pruned = await createRepository(env.DB).auditEvents.pruneBefore({
      changedBefore: new Date(event.scheduledTime - FLAG_CHANGE_LOG_RETENTION_MS).toISOString(),
      limit: RETENTION_BATCH,
    });
    workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
      "info",
      "audit-event-retention",
      { service, job: "audit-event-retention", cron: event.cron, pruned },
    );
  } catch (error) {
    createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
      "audit_event_retention_failed",
      { service, job: "audit-event-retention", cron: event.cron, fault: serializeFault(error) },
    );
    throw new Error("audit_event_retention_failed");
  }
}

async function runCloudflarePushDispatch(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  try {
    const dispatched = await dispatchCloudflarePushes({
      policy: cronDeliveryPolicy("cloudflare", () => new Date(event.scheduledTime)),
      repo: createRepository(env.DB),
      secretKek: env.INTEGRATION_SECRET_KEK,
      secretKeyVersion: env.INTEGRATION_SECRET_KEY_VERSION,
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
        fault: serializeFault(error),
      },
    );
    throw new Error("cloudflare_push_dispatch_failed");
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
        fault: serializeFault(error),
      },
    );
    throw new Error("sentry_webhook_dispatch_failed");
  }
}

// With no active installation, age alone governs retention. A zero cursor
// would instead prevent pruning any events.
async function runFlagChangeLogRetention(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const repo = createRepository(env.DB);
  const scheduled = new Date(event.scheduledTime);
  const cursor = await repo.sentry.minUndeliveredSeq();
  const pruned = await repo.flagChangeEvents.pruneBefore({
    changedBefore: new Date(scheduled.getTime() - FLAG_CHANGE_LOG_RETENTION_MS).toISOString(),
    minUndeliveredSeq: cursor ?? Number.MAX_SAFE_INTEGER,
    limit: RETENTION_BATCH,
  });
  workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
    "info",
    "flag-change-log-retention",
    { service, job: "flag-change-log-retention", cron: event.cron, pruned, cursor },
  );
}

const RETENTION_BATCH = 1_000;

async function runConvexWebhookDispatch(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const dispatched = await dispatchConvexWebhooks({
    policy: cronDeliveryPolicy("convex", () => new Date(event.scheduledTime)),
    repo: createRepository(env.DB),
    webhookKek: env.CONVEX_WEBHOOK_KEK,
    webhookKeyVersion: env.CONVEX_WEBHOOK_KEY_VERSION,
    onDispatch: (summary) =>
      workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
        "info",
        "convex-webhook-dispatch-outcomes",
        { service, job: "convex-webhook-dispatch", ...summary },
      ),
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
  const privacyExportArtifacts = await deleteOrphanedPrivacyExports(env.PRIVACY_EXPORTS, repo);
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
      privacyExportArtifacts,
    },
  );
}

/** The daily retry is how a halted claim retention backfill resumes, so each failure is reported. */
async function runMetricEventClaimRetentionAdoption(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  try {
    await env.EVENT_INGEST_API.adoptMetricEventClaimRetention();
  } catch (error) {
    createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
      "metric_event_claim_retention_adoption_failed",
      {
        service,
        job: "metric-event-claim-retention-adoption",
        cron: event.cron,
        fault: serializeFault(error),
      },
    );
    throw new Error("metric_event_claim_retention_adoption_failed");
  }
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
        fault: serializeFault(error),
      },
    );
    throw new Error("approval_request_archive_failed");
  }
}
