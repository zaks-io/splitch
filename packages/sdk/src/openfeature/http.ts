import { toOfrepErrorCode } from "./error-code";
import type { OfrepEvaluationContext, OfrepResolutionDetails } from "./types";

const OFREP_REASONS = new Set(["STATIC", "TARGETING_MATCH", "SPLIT", "DISABLED", "UNKNOWN"]);

export interface OfrepHttpConfig {
  readonly baseUrl: string;
  readonly credential: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
  readonly headers: Readonly<Record<string, string>>;
}

export async function evaluateOfrepFlag(
  config: OfrepHttpConfig,
  flagKey: string,
  context: OfrepEvaluationContext,
): Promise<OfrepResolutionDetails<unknown>> {
  const url = new URL(`/ofrep/v1/evaluate/flags/${encodeURIComponent(flagKey)}`, config.baseUrl);
  try {
    // Fetch and body read share one abort timer: headers-only completion must not
    // clear the timeout before response.json() finishes.
    return await withTimeout(config, async (signal) => {
      const response = await config.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.credential}`,
          "content-type": "application/json",
          "x-splitch-sdk-runtime": "javascript",
          ...config.headers,
        },
        body: JSON.stringify({ context }),
        signal,
      });
      const body = await readJsonBody(response);
      return response.status === 200 ? ofrepSuccess(body) : ofrepFailure(response.status, body);
    });
  } catch (error) {
    return transportFailure(error);
  }
}

function ofrepSuccess(body: Record<string, unknown>): OfrepResolutionDetails<unknown> {
  const parsed = parseSuccessEnvelope(body);
  if (!parsed.ok) {
    return {
      value: undefined,
      reason: "ERROR",
      errorCode: toOfrepErrorCode("PARSE_ERROR"),
      errorMessage: parsed.errorMessage,
    };
  }
  return {
    value: parsed.value,
    ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
    reason: parsed.reason,
    ...(parsed.flagMetadata === undefined ? {} : { flagMetadata: parsed.flagMetadata }),
  };
}

function parseSuccessEnvelope(body: Record<string, unknown>):
  | {
      ok: true;
      value: unknown;
      reason: string;
      variant?: string;
      flagMetadata?: Record<string, boolean | string | number>;
    }
  | { ok: false; errorMessage: string } {
  if (typeof body.key !== "string" || body.key.length === 0) {
    return { ok: false, errorMessage: "OFREP success body is missing a non-empty key" };
  }
  if (typeof body.reason !== "string" || !OFREP_REASONS.has(body.reason)) {
    return { ok: false, errorMessage: "OFREP success body is missing a valid reason" };
  }
  if (body.variant !== undefined && typeof body.variant !== "string") {
    return { ok: false, errorMessage: "OFREP success body variant must be a string when present" };
  }
  if (body.metadata !== undefined && !isMetadata(body.metadata)) {
    return { ok: false, errorMessage: "OFREP success body metadata is invalid" };
  }
  return {
    ok: true,
    value: body.value,
    reason: body.reason,
    ...(typeof body.variant === "string" ? { variant: body.variant } : {}),
    ...(isMetadata(body.metadata) ? { flagMetadata: body.metadata } : {}),
  };
}

function ofrepFailure(
  status: number,
  body: Record<string, unknown>,
): OfrepResolutionDetails<unknown> {
  return {
    value: undefined,
    reason: "ERROR",
    errorCode: toOfrepErrorCode(
      body.errorCode,
      status === 404 ? toOfrepErrorCode("FLAG_NOT_FOUND") : toOfrepErrorCode("GENERAL"),
    ),
    errorMessage:
      typeof body.errorDetails === "string"
        ? body.errorDetails
        : `OFREP evaluate failed: HTTP ${String(status)}`,
  };
}

function transportFailure(error: unknown): OfrepResolutionDetails<unknown> {
  const aborted = isAbortError(error);
  return {
    value: undefined,
    reason: "ERROR",
    // OpenFeature's ErrorCode enum has no TIMEOUT member; surface timeout via
    // GENERAL + errorMessage so ResolutionDetails stays Provider-assignable.
    errorCode: toOfrepErrorCode("GENERAL"),
    errorMessage: aborted
      ? "OFREP evaluate timed out"
      : error instanceof Error
        ? error.message
        : "OFREP evaluate failed",
  };
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("OFREP response body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function isMetadata(value: unknown): value is Record<string, boolean | string | number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) => typeof entry === "boolean" || typeof entry === "string" || typeof entry === "number",
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

async function withTimeout<Result>(
  config: OfrepHttpConfig,
  run: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
