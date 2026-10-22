import { createRepository, type ScheduledDueWork } from "@splitch/db";
import {
  createWorkerFaultReporter,
  serializeFault,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import { RECONCILE_DELAY_MS } from "./entity-privacy-jobs";
import type { ControlPlaneApiEnv } from "./env";
import { PERSONAL_ACCESS_TOKEN_RECOVERY_DELAY_MS } from "./personal-access-token-rotation";

export async function scheduledDueWork(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<ScheduledDueWork> {
  try {
    return await createRepository(env.DB).scheduledDueWork({
      now: new Date(event.scheduledTime).toISOString(),
      privacyUpdatedBefore: new Date(event.scheduledTime - RECONCILE_DELAY_MS).toISOString(),
      rotationUpdatedBefore: new Date(
        event.scheduledTime - PERSONAL_ACCESS_TOKEN_RECOVERY_DELAY_MS,
      ).toISOString(),
    });
  } catch (error) {
    createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
      "scheduled_due_work_probe_failed",
      { service: "splitch-control-plane-api", cron: event.cron, fault: serializeFault(error) },
    );
    return {
      privacyReconciliation: true,
      privacyArtifactPurge: true,
      personalAccessTokenRetention: true,
      temporaryEnvironmentTeardown: true,
      auditEventForwarding: true,
      convexWebhookDispatch: true,
      cloudflarePushDispatch: true,
      sentryWebhookDispatch: true,
    };
  }
}
