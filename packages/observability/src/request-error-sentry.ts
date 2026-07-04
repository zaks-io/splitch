import { errorCodes, httpStatusForError, type ErrorCode } from "@splitch/contracts";

export interface RequestErrorContext {
  readonly requestId: string;
  readonly code: string;
  readonly status: number;
}

const errorCodeSet = new Set<string>(errorCodes);

function isErrorCode(code: string): code is ErrorCode {
  return errorCodeSet.has(code);
}

/** Resolve the HTTP status for registrar observability callbacks. */
export function resolveRequestErrorStatus(ctx: RequestErrorContext): number {
  if (ctx.status > 0) {
    return ctx.status;
  }
  if (isErrorCode(ctx.code)) {
    return httpStatusForError(ctx.code);
  }
  return ctx.status;
}

/**
 * True when a registrar/domain failure is a true fault that should become a
 * Sentry error event. Expected validation/auth/rate-limit/scope failures are
 * normal control flow and must not page.
 */
export function shouldReportRequestErrorToSentry(ctx: RequestErrorContext): boolean {
  if (ctx.code === "INTERNAL_SERVER_ERROR") {
    return true;
  }
  return resolveRequestErrorStatus(ctx) >= 500;
}
