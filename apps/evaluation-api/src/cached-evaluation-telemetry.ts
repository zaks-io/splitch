import type { ErrorResponse } from "@splitch/contracts";
import type { HandlerArgs, Principal } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { appIdentityTrafficError } from "./app-identity-traffic";
import type { ExposureAssemblyDeps } from "./evaluate/exposure-assembly";
import { errorResponse } from "./evaluation-error-response";
import { type EvaluationUsageScope, writeEvaluationUsage } from "./evaluation-usage";
import type { EvaluationUsageSink } from "./evaluation-usage-sink";

export function makeCachedEvaluationTelemetryHandler(deps: {
  evaluationUsageSink: EvaluationUsageSink;
  exposureAssembly: ExposureAssemblyDeps;
  logger?: Pick<Console, "error">;
}) {
  return async ({
    input,
    principal,
    requestId,
    request,
  }: HandlerArgs<unknown>): Promise<Response> => {
    const scope = credentialScope(principal);
    if (!scope.ok) return renderError(scope.error, { requestId });
    const identityError = await appIdentityTrafficError(
      deps.exposureAssembly.saltStore,
      scope.value.appId,
    );
    if (identityError !== null) return renderError(identityError, { requestId });
    const body = telemetryBody(input);
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
    const write = await writeEvaluationUsage(
      false,
      idempotencyKey,
      scope.value,
      { flagKey: body.flagKey, sdkRuntime: sdkRuntime(request) },
      deps,
      () => errorResponse("SERVICE_UNAVAILABLE", "Evaluation usage ingest is unavailable"),
      true,
    );
    return write.ok ? Response.json({ ok: true }) : renderError(write.error, { requestId });
  };
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

function telemetryBody(input: unknown): { flagKey: string; idempotencyKey: string } {
  const body = record(record(input).body);
  return {
    flagKey: stringField(body, "flagKey"),
    idempotencyKey: stringField(body, "idempotencyKey"),
  };
}

function sdkRuntime(request: Request): string {
  const value = request.headers.get("x-splitch-sdk-runtime");
  return value && value.length <= 64 ? value : "unknown";
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("evaluation-api: expected parsed object input");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`evaluation-api: missing ${key}`);
  }
  return field;
}
