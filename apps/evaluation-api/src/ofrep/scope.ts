import type { ErrorResponse } from "@splitch/contracts";
import type { Principal } from "@splitch/worker-runtime";
import { errorResponse } from "../evaluation-error-response";
import type { EvaluationUsageScope } from "../evaluation-usage";

export function ofrepCredentialScope(
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

export function billingIdempotencyKey(request: Request): string {
  return request.headers.get("idempotency-key") ?? crypto.randomUUID();
}
