import type { ErrorResponse } from "@splitch/contracts";

export function scopeUnresolvedError(
  resource: "App" | "Environment",
  parameter: string,
): ErrorResponse {
  return {
    code: "SCOPE_UNRESOLVED",
    message: `${resource} scope is unresolved. Call context_use or pass ${parameter} explicitly.`,
    details: { parameter, resource },
  };
}

export function contextUseInvalidError(
  message: string,
  issues: ReadonlyArray<{ path: string[]; message: string }>,
): ErrorResponse {
  return {
    code: "CONTEXT_USE_INVALID",
    message,
    details: { issues: [...issues] },
  };
}

export function invalidToolArgumentsError(
  issues: ReadonlyArray<{ path: string[]; message: string }>,
  message: string,
): ErrorResponse {
  return {
    code: "VALIDATION_ERROR",
    message,
    details: { issues: [...issues] },
  };
}
