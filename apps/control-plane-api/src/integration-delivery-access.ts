import { type EnvScope, envScope } from "@splitch/db";
import { mapWithConcurrency } from "./bounded-map";
import type { ControlPlaneApiEnv } from "./env";

export interface IntegrationDeliveryDurableObjectNamespace {
  getByName(name: string): { wake(appId: string, environmentId: string): Promise<void> };
}

export function integrationDeliveryName(appId: string, environmentId: string): string {
  envScope(appId, environmentId);
  return `${appId}:${environmentId}`;
}

export async function wakeIntegrationDelivery(
  env: Pick<ControlPlaneApiEnv, "INTEGRATION_DELIVERY">,
  scopes: readonly Pick<EnvScope, "appId" | "environmentId">[],
): Promise<void> {
  const results = await mapWithConcurrency(scopes, 6, async ({ appId, environmentId }) => {
    try {
      await env.INTEGRATION_DELIVERY.getByName(integrationDeliveryName(appId, environmentId)).wake(
        appId,
        environmentId,
      );
      return { ok: true as const };
    } catch (cause) {
      return { ok: false as const, cause };
    }
  });
  const failures = results.filter((result) => !result.ok);
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.cause),
      "Integration delivery wakes failed",
    );
}
