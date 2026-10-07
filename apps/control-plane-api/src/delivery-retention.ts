import { createRepository } from "@splitch/db";
import {
  createWorkerFaultReporter,
  workerEmitter,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import type { ControlPlaneApiEnv } from "./env";

const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export async function runDeliveryRetention(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const observability = workerObservabilityWithWaitUntil("control-plane-api", ctx);
  const attributes = {
    service: "splitch-control-plane-api",
    job: "delivery-retention",
    cron: event.cron,
  };
  try {
    const repo = createRepository(env.DB);
    const input = {
      completedBefore: new Date(event.scheduledTime - DELIVERY_RETENTION_MS).toISOString(),
      limit: 1_000,
    };
    const convex = await repo.convex.pruneDeliveries(input);
    const cloudflare = await repo.cloudflare.pruneDeliveries(input);
    const counts = {
      ...attributes,
      completedBefore: input.completedBefore,
      limit: input.limit,
      convex,
      cloudflare,
    };
    const emitter = workerEmitter(env, observability);
    emitter.log("info", "delivery-retention", counts);
    if (convex === input.limit || cloudflare === input.limit) {
      emitter.log("warn", "delivery-retention-batch-limit-reached", counts);
      createWorkerFaultReporter(env, observability)(
        "delivery_retention_batch_limit_reached",
        counts,
      );
    }
  } catch (error) {
    createWorkerFaultReporter(env, observability)("delivery_retention_failed", {
      ...attributes,
      fault: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    throw error;
  }
}
