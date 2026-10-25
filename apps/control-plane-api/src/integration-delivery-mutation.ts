import { appScope, type EnvScope, type Repository } from "@splitch/db";
import {
  createWorkerFaultReporter,
  serializeFault,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import { dispatchCloudflarePushes } from "./cloudflare-push-dispatch";
import { integrationDeliveryMode } from "./control-plane-runtime-config";
import type { ControlPlaneApiEnv } from "./env";
import { wakeIntegrationDelivery } from "./integration-delivery-access";

export async function dispatchAppIntegrationDelivery(
  env: ControlPlaneApiEnv,
  repo: Repository,
  appId: string,
): Promise<void> {
  const scope = appScope(appId);
  if (integrationDeliveryMode(env) === "cron") {
    await dispatchCloudflarePushes({
      repo,
      scope,
      secretKek: env.INTEGRATION_SECRET_KEK,
      secretKeyVersion: env.INTEGRATION_SECRET_KEY_VERSION,
    });
    return;
  }
  const scopes = await repo.integrationDeliverySchedule.environmentsWithDueDeliveries({
    now: new Date().toISOString(),
    scope,
  });
  await wakeIntegrationDelivery(env, scopes);
}

export function integrationRegistrationWake(
  env: ControlPlaneApiEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
): ((scope: EnvScope) => void) | undefined {
  if (integrationDeliveryMode(env) === "cron") return undefined;
  return (scope) => {
    ctx.waitUntil(
      wakeIntegrationDelivery(env, [scope]).catch((error) => {
        createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
          "integration_delivery_wake_failed",
          { appId: scope.appId, environmentId: scope.environmentId, fault: serializeFault(error) },
        );
        throw new Error("integration_delivery_wake_failed");
      }),
    );
  };
}
