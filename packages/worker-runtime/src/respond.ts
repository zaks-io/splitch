import { type ErrorCode, type ErrorResponse, httpStatusForError } from "@splitch/contracts";

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Render an ErrorResponse as an HTTP Response with the canonical status from the
 * shared map. The single place the guard turns an error code into a wire
 * response. Handlers that need to emit a domain error use this too, so every
 * surface gets one status table.
 */
export function renderError(
  error: ErrorResponse,
  opts: {
    requestId: string;
    defaultHeaders?: Record<string, string> | undefined;
  },
): Response {
  const status = httpStatusForError(error.code);
  const headers = new Headers(opts.defaultHeaders);
  headers.set("content-type", "application/json");
  headers.set(REQUEST_ID_HEADER, opts.requestId);

  const retryAfterMs = retryAfterMsFor(error);
  if (retryAfterMs !== null) {
    headers.set("retry-after", String(Math.ceil(retryAfterMs / 1000)));
  }

  return new Response(JSON.stringify(error), { status, headers });
}

/** Build an ErrorResponse for a code whose details are empty (`{}`). */
export function emptyError(code: EmptyDetailCode, message: string): ErrorResponse {
  return { code, message, details: {} } as ErrorResponse;
}

/** Codes whose detail shape is `{}` — the guard only ever emits from this set plus the structured ones it builds explicitly. */
export type EmptyDetailCode = Extract<
  ErrorCode,
  "UNAUTHORIZED" | "CREDENTIAL_REVOKED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR" | "APP_MISMATCH"
>;

function retryAfterMsFor(error: ErrorResponse): number | null {
  if (error.code === "RATE_LIMITED" || error.code === "SERVICE_UNAVAILABLE") {
    return error.details.retryAfterMs;
  }
  return null;
}
