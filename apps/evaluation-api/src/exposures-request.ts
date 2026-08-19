import type { ErrorResponse, ExposureBatchRequest } from "@splitch/contracts";
import type { Principal } from "@splitch/worker-runtime";
import { errorResponse } from "./evaluation-error-response";

export type CredentialScope = {
  readonly organizationId: string;
  readonly appId: string;
  readonly environmentId: string;
};

export function exposureBatchBody(
  input: unknown,
): { ok: true; value: ExposureBatchRequest } | { ok: false; error: ErrorResponse } {
  const root = asRecord(input);
  const body = root?.body;
  if (
    typeof body !== "object" ||
    body === null ||
    !("exposures" in body) ||
    !Array.isArray((body as { exposures: unknown }).exposures)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Exposure batch body is required",
        details: { issues: [{ path: ["body"], message: "exposures is required" }] },
      },
    };
  }
  return { ok: true, value: body as ExposureBatchRequest };
}

export function credentialScope(
  principal: Principal,
): { ok: true; value: CredentialScope } | { ok: false; error: ErrorResponse } {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
