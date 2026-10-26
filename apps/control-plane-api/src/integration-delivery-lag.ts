import { createRepository, type ScheduledDueWorkResult } from "@splitch/db";
import {
  createWorkerFaultReporter,
  serializeFault,
  workerEmitter,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import type { ControlPlaneApiEnv } from "./env";

const ALERT_AGE_MS = 5 * 60 * 1000;

export async function runIntegrationDeliveryLag(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
  preloaded?: ScheduledDueWorkResult["delivery"],
): Promise<void> {
  await Promise.all(
    (["convex", "cloudflare"] as const).map((provider) =>
      reportProviderLag(provider, env, event, ctx, preloaded?.lag[provider]),
    ),
  );
}

async function reportProviderLag(
  provider: "convex" | "cloudflare",
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
  preloadedRows?: NonNullable<ScheduledDueWorkResult["delivery"]>["lag"]["convex"],
): Promise<void> {
  const observability = workerObservabilityWithWaitUntil("control-plane-api", ctx);
  const reportFault = createWorkerFaultReporter(env, observability);
  const detail = { service: "splitch-control-plane-api", cron: event.cron, provider };
  const emitter = workerEmitter(env, observability, {
    onStructuredLogEvents: (events) => {
      for (const row of events) console.info(row);
    },
  });
  try {
    const rows =
      preloadedRows ??
      (await createRepository(env.DB)[provider].deliveryLag(
        new Date(event.scheduledTime).toISOString(),
      ));
    for (const row of rows) {
      const oldestMs = Date.parse(row.oldestOutstandingAt);
      if (!Number.isFinite(oldestMs)) throw new Error("Invalid outstanding delivery timestamp");
      const fields = {
        ...detail,
        appId: row.appId,
        environmentId: row.environmentId,
        oldestAgeMs: event.scheduledTime - oldestMs,
        healthyInstallationsWaiting: row.healthyInstallationsWaiting,
      };
      emitter.log("info", "integration-delivery-lag", fields);
      if (fields.oldestAgeMs > ALERT_AGE_MS) reportFault("integration_delivery_lagging", fields);
    }
  } catch (error) {
    // Monitoring must not prevent dispatch or the other provider's lag report.
    reportFault("integration_delivery_lag_read_failed", {
      ...detail,
      fault: serializeFault(error),
    });
  }
}
