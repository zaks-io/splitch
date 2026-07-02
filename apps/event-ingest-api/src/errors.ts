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
  return Response.json(error, { status: httpStatusForError(error.code) });
}
