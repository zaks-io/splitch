import { createRepository } from "@splitch/db";
import {
  createWorkerFaultReporter,
  serializeFault,
  workerEmitter,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import { durableConfigStoreAccess } from "./config-store-access";
import type { ControlPlaneApiEnv } from "./env";
import { createEnvironmentExposureStatusCleanup } from "./environment-exposure-status-cleanup";
import { teardownTemporaryEnvironment } from "./temporary-environment-teardown";

export async function runTemporaryEnvironmentTeardown(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const repo = createRepository(env.DB);
  const now = new Date(event.scheduledTime).toISOString();
  const observability = workerObservabilityWithWaitUntil("control-plane-api", ctx);
  const report = createWorkerFaultReporter(env, observability);
  const emitter = workerEmitter(env, observability, {
    onStructuredLogEvents: (events) => {
      for (const entry of events) console.info(entry);
    },
  });
  let failed = false;
  try {
    const rows = await repo.identity.listExpiredTemporaryEnvironments(now, 5);
    for (const row of rows) {
      try {
        const app = await repo.identity.getApp(row.appId);
        if (!app)
          throw new Error("Temporary Environment teardown manifest references a missing App");
        await teardownTemporaryEnvironment(
          {
            repo,
            configStore: durableConfigStoreAccess(env.CONFIG_STORE_WRITER, env.CONFIG_STORE),
            credentialStore: env.CREDENTIAL_STORE,
            credentialCacheWriter: {
              writerFor: (key) => env.CREDENTIAL_CACHE_WRITER.getByName(key),
            },
            exposureStatusCleanup: createEnvironmentExposureStatusCleanup(env.ANALYSIS_API),
            nowIso: () => now,
          },
          {
            appId: row.appId,
            environmentId: row.id,
            actorId: "system:temporary-environment-teardown",
            orgId: app.organizationId,
            requestId: crypto.randomUUID(),
          },
        );
        emitter.log("info", "temporary-environment-teardown", {
          service: "splitch-control-plane-api",
          job: "temporary-environment-teardown",
          cron: event.cron,
          appId: row.appId,
          environmentId: row.id,
          deleted: 1,
        });
      } catch (error) {
        failed = true;
        report("temporary_environment_teardown_failed", {
          service: "splitch-control-plane-api",
          cron: event.cron,
          appId: row.appId,
          environmentId: row.id,
          fault: serializeFault(error),
        });
      }
    }
  } catch (error) {
    failed = true;
    report("temporary_environment_teardown_failed", {
      service: "splitch-control-plane-api",
      cron: event.cron,
      fault: serializeFault(error),
    });
  }
  if (failed) throw new Error("temporary_environment_teardown_failed");
}
