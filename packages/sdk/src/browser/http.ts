import type { SplitchSdkErrorCode } from "../errors";
import { ErrorCodeSchema } from "../generated/contract-surface.js";

/** HTTP status for an HTTP outcome, or `null` for a local transport failure. */
export interface BrowserTransportFailure {
  readonly status: number | null;
  readonly errorCode?: SplitchSdkErrorCode;
  readonly errorMessage?: string;
  readonly cause?: unknown;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function networkFailure(cause: unknown): BrowserTransportFailure {
  return {
    status: null,
    errorCode: "SDK_TRANSPORT_NETWORK",
    errorMessage: errorMessage(cause, "transport request failed"),
    cause,
  };
}

function timeoutFailure(cause: unknown): BrowserTransportFailure {
  return {
    status: null,
    errorCode: "SDK_TRANSPORT_TIMEOUT",
    errorMessage: errorMessage(cause, "request timed out"),
    cause,
  };
}

function parseFailure(cause: unknown): BrowserTransportFailure {
  return {
    status: null,
    errorCode: "SDK_TRANSPORT_PARSE",
    errorMessage: errorMessage(cause, "response body was unparseable"),
    cause,
  };
}

export function classifyCaughtError(error: unknown): BrowserTransportFailure {
  return isAbortError(error) ? timeoutFailure(error) : networkFailure(error);
}

export function classifyBodyReadError(error: unknown): BrowserTransportFailure {
  return isAbortError(error) ? timeoutFailure(error) : parseFailure(error);
}

export async function readFailure(response: Response): Promise<BrowserTransportFailure> {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    const parsedCode = ErrorCodeSchema.safeParse(body.code);
    return {
      status: response.status,
      errorCode: parsedCode.success ? parsedCode.data : undefined,
      errorMessage: typeof body.message === "string" ? body.message : undefined,
    };
  } catch (error) {
    return isAbortError(error)
      ? classifyBodyReadError(error)
      : { status: response.status, cause: error };
  }
}

export async function withTimeout<Result>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await call(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
