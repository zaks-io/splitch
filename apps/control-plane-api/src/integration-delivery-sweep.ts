import { createRepository } from "@splitch/db";
import {
  createWorkerFaultReporter,
  serializeFault,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import type { ControlPlaneApiEnv } from "./env";
import { wakeIntegrationDelivery } from "./integration-delivery-access";

export async function runIntegrationDeliverySweep(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
  preloadedScopes?: Array<{ appId: string; environmentId: string }>,
): Promise<void> {
  try {
    const scopes =
      preloadedScopes ??
      (await createRepository(env.DB).integrationDeliverySchedule.environmentsWithDueDeliveries({
        now: new Date(event.scheduledTime).toISOString(),
      }));
    await wakeIntegrationDelivery(env, scopes);
  } catch (error) {
    createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
      "integration_delivery_sweep_failed",
      { cron: event.cron, fault: serializeFault(error) },
    );
    throw new Error("integration_delivery_sweep_failed");
  }
}
