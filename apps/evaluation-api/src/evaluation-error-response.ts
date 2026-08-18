import type { ErrorCode, ErrorResponse } from "@splitch/contracts";

export function errorResponse(code: ErrorCode, message: string): ErrorResponse {
  if (code === "FLAG_NOT_FOUND") {
    return { code, message: "flag not found", details: {} };
  }
  if (code === "VALIDATION_ERROR") {
    return { code, message, details: { issues: [] } };
  }
  if (code === "UNSUPPORTED_OBJECT_KEY") {
    return {
      code,
      message,
      details: { key: "__proto__", path: ["evaluations", "__proto__"] },
    };
  }
  if (code === "INTERNAL_SERVER_ERROR") {
    return { code, message: "evaluation failed", details: {} };
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return { code, message, details: { retryAfterMs: 1000 } };
  }
  return { code, message, details: {} } as ErrorResponse;
}
