import { errorCodes, httpStatusForError, type ErrorCode } from "@splitch/contracts";

export interface RequestErrorContext {
  readonly requestId: string;
  readonly code: string;
  readonly status: number;
  /** The value that was thrown, on the fault path. Never reaches the response. */
  readonly cause?: unknown;
}

/** A fault context ready to emit: `cause` replaced by its identity. */
export interface RequestErrorReport {
  readonly requestId: string;
  readonly code: string;
  readonly status: number;
  readonly fault?: string;
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
 * Reduce a fault context for emission. The response body for a 500 is only ever
 * "unhandled runtime fault" -- deliberately, so internals never leak to callers
 * -- which means this is the ONLY place the thrown value can reach an operator.
 * Dropping it makes every fault look identical and undiagnosable.
 *
 * Reduced to a string rather than passed through so an arbitrary thrown object
 * cannot widen what gets emitted; the scrubber runs over the result downstream.
 */
export function reduceRequestError(ctx: RequestErrorContext): RequestErrorReport {
  const { requestId, code, cause } = ctx;
  const status = resolveRequestErrorStatus(ctx);
  const fault = faultIdentity(cause);
  return { requestId, code, status, ...(fault === undefined ? {} : { fault }) };
}

/**
 * Total by construction: this runs inside the registrar's own catch block, so a
 * throw here escapes the one handler that renders the contract-shaped 500 and
 * the caller gets Hono's plain-text default instead -- no code, no request id.
 * Both `String()` (null-prototype objects, a throwing `toString`) and a `.stack`
 * getter are real throw sites, so the whole reduction is guarded.
 */
function faultIdentity(cause: unknown): string | undefined {
  if (cause === undefined) return undefined;
  try {
    if (cause instanceof Error) {
      return errorIdentity(cause);
    }
    // A non-Error throw has no stack to give; naming the shape still beats silence.
    return `non-Error thrown (${typeof cause}): ${String(cause)}`;
  } catch {
    // `String()` on a null-prototype object and a throwing `toString` both land
    // here. `typeof` cannot throw, so this label is always constructible.
    return `unrepresentable thrown value (${typeof cause})`;
  }
}

/**
 * `.stack` is a getter and can throw, but `name`/`message` normally still read.
 * Losing the frames is survivable; discarding the error's identity as well would
 * report a genuine Error as an anonymous non-Error, which is worse than useless.
 */
function errorIdentity(cause: Error): string {
  try {
    const stack = cause.stack;
    if (stack) {
      return stack;
    }
  } catch {
    // Frames are gone; identity below is still worth having.
  }
  return `${cause.name}: ${cause.message}`;
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
