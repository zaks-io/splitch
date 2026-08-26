import { httpStatusForError, type ErrorResponse } from "@splitch/contracts";

type EmptyDetailCode =
  | "UNAUTHORIZED"
  | "EXPERIMENT_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "INTERNAL_SERVER_ERROR";

export function validationError(message: string, path: string[]): ErrorResponse {
  return {
    code: "VALIDATION_ERROR",
    message,
    details: { issues: [{ path, message }] },
  };
}

export function serviceUnavailable(message: string): ErrorResponse {
  return {
    code: "SERVICE_UNAVAILABLE",
    message,
    details: { retryAfterMs: 1000 },
  };
}

export function emptyError(code: EmptyDetailCode, message: string): ErrorResponse {
  return { code, message, details: {} } as ErrorResponse;
}

export function renderError(error: ErrorResponse): Response {
  const headers = new Headers({ "content-type": "application/json" });
  const retryAfterMs = retryAfterMsFor(error);
  if (retryAfterMs !== null) {
    headers.set("retry-after", String(Math.ceil(retryAfterMs / 1_000)));
  }
  return new Response(JSON.stringify(error), {
    status: httpStatusForError(error.code),
    headers,
  });
}

function retryAfterMsFor(error: ErrorResponse): number | null {
  if (error.code === "RATE_LIMITED" || error.code === "SERVICE_UNAVAILABLE") {
    return error.details.retryAfterMs;
  }
  return null;
}
