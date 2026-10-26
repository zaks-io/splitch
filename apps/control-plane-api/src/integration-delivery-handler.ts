import { envScope, type Repository } from "@splitch/db";
import { type createWorkerFaultReporter, serializeFault } from "@splitch/observability/worker";
import { type RouteHandler, renderError } from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz";
import { appNotFound } from "./app-environment-model";
import { integrationDeliveryMode } from "./control-plane-runtime-config";
import type { ControlPlaneApiEnv } from "./env";
import { environmentExists } from "./experiment-handler-shared";
import { wakeIntegrationDelivery } from "./integration-delivery-access";

export type IntegrationDeliveryAccess = Pick<
  ControlPlaneApiEnv,
  "INTEGRATION_DELIVERY" | "INTEGRATION_DELIVERY_MODE"
>;

export function makeIntegrationDeliveryHandler(deps: {
  repo: Repository;
  delivery?: IntegrationDeliveryAccess;
  onFault?: ReturnType<typeof createWorkerFaultReporter>;
  nowMs?: () => number;
}): RouteHandler<{ params: { appId: string; environmentId: string } }> {
  return async ({ input, principal, requestId }) => {
    const denied = await requireAppAdmin(deps, input.params.appId, principal, requestId);
    if (denied) return denied;
    const scope = envScope(input.params.appId, input.params.environmentId);
    if (!(await environmentExists(deps, scope))) return appNotFound(requestId);
    const wake = await requestWake(deps.delivery, scope, requestId, deps.onFault);
    if (wake instanceof Response) return wake;
    const providers = await deps.repo.integrationDeliverySchedule.outstandingSummary(
      scope,
      (deps.nowMs ?? Date.now)(),
    );
    return Response.json({
      ...input.params,
      wake,
      providers,
    });
  };
}

async function requestWake(
  delivery: IntegrationDeliveryAccess | undefined,
  scope: ReturnType<typeof envScope>,
  requestId: string,
  onFault: ReturnType<typeof createWorkerFaultReporter> | undefined,
): Promise<"scheduled" | "cron_noop" | Response> {
  if (!delivery) return unavailable(requestId);
  if (integrationDeliveryMode(delivery) === "cron") return "cron_noop";
  try {
    await wakeIntegrationDelivery(delivery, [scope]);
    return "scheduled";
  } catch (error) {
    onFault?.("integration_delivery_wake_failed", {
      appId: scope.appId,
      environmentId: scope.environmentId,
      requestId,
      fault: serializeFault(error),
    });
    return unavailable(requestId);
  }
}

function unavailable(requestId: string) {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "Integration delivery coordinator is unavailable",
      details: { retryAfterMs: 30_000 },
    },
    { requestId },
  );
}
