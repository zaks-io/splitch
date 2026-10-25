import { createRepository } from "@splitch/db";
import {
  createWorkerFaultReporter,
  serializeFault,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import { reprobeDormantConvexDeployments } from "./convex-deployments";
import type { ControlPlaneApiEnv } from "./env";

export async function runConvexDeploymentReprobes(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  try {
    await reprobeDormantConvexDeployments({
      repo: createRepository(env.DB),
      now: new Date(event.scheduledTime),
    });
  } catch (cause) {
    createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
      "convex_deployment_reprobe_failed",
      { service: "splitch-control-plane-api", cron: event.cron, fault: serializeFault(cause) },
    );
    throw new Error("convex_deployment_reprobe_failed");
  }
}
