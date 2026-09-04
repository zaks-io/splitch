import type { ErrorResponse } from "@splitch/contracts";
import type { HandlerArgs, Principal } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { appIdentityAdmissionValidationError, tryAdmitAppIdentity } from "./app-identity-traffic";
import type { ExposureAssemblyDeps } from "./evaluate/exposure-assembly";
import { errorResponse } from "./evaluation-error-response";
import { cachedEvaluationTelemetryRouteInput } from "./evaluation-route-input";
import { type EvaluationUsageScope, writeEvaluationUsage } from "./evaluation-usage";
import type { EvaluationUsageSink } from "./evaluation-usage-sink";

export function makeCachedEvaluationTelemetryHandler(deps: {
  evaluationUsageSink: EvaluationUsageSink;
  exposureAssembly: ExposureAssemblyDeps;
  logger?: Pick<Console, "error">;
}) {
  return (args: HandlerArgs<unknown>): Promise<Response> => handleCachedTelemetry(args, deps);
}

async function handleCachedTelemetry(
  { input, principal, requestId, request }: HandlerArgs<unknown>,
  deps: {
    evaluationUsageSink: EvaluationUsageSink;
    exposureAssembly: ExposureAssemblyDeps;
    logger?: Pick<Console, "error">;
  },
): Promise<Response> {
  const scope = credentialScope(principal);
  if (!scope.ok) return renderError(scope.error, { requestId });
  const admitted = await tryAdmitAppIdentity(deps.exposureAssembly.saltStore, scope.value.appId);
  if (!admitted.ok) return renderError(admitted.error, { requestId });
  const body = cachedEvaluationTelemetryRouteInput(input).body;
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || body.idempotencyKey !== idempotencyKey) {
    return renderError(
      errorResponse(
        "VALIDATION_ERROR",
        "Idempotency-Key header must match the cached Evaluation telemetry body",
      ),
      { requestId },
    );
  }
  const stale = await appIdentityAdmissionValidationError(admitted.admission);
  if (stale !== null) return renderError(stale, { requestId });
  const write = await writeEvaluationUsage(
    false,
    idempotencyKey,
    scope.value,
    admitted.admission.identityVersion,
    { flagKey: body.flagKey, sdkRuntime: sdkRuntime(request) },
    deps,
    () => errorResponse("SERVICE_UNAVAILABLE", "Evaluation usage ingest is unavailable"),
    true,
  );
  if (!write.ok) return renderError(write.error, { requestId });
  const staleBeforeSuccess = await appIdentityAdmissionValidationError(admitted.admission);
  return staleBeforeSuccess === null
    ? Response.json({ ok: true })
    : renderError(staleBeforeSuccess, { requestId });
}

function credentialScope(
  principal: Principal,
): { ok: true; value: EvaluationUsageScope } | { ok: false; error: ErrorResponse } {
  if (principal.orgId === null || principal.appId === null || principal.environmentId === null) {
    return {
      ok: false,
      error: errorResponse("SERVICE_UNAVAILABLE", "credential cache migration is required"),
    };
  }
  return {
    ok: true,
    value: {
      organizationId: principal.orgId,
      appId: principal.appId,
      environmentId: principal.environmentId,
    },
  };
}

function sdkRuntime(request: Request): string {
  const value = request.headers.get("x-splitch-sdk-runtime");
  return value && value.length <= 64 ? value : "unknown";
}
