import type { OfrepEvaluationContext, OfrepResolutionDetails } from "./types";

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
  const response = await withTimeout(config, (signal) =>
    config.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.credential}`,
        "content-type": "application/json",
        "x-splitch-sdk-runtime": "javascript",
        ...config.headers,
      },
      body: JSON.stringify({ context }),
      signal,
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  return response.status === 200 ? ofrepSuccess(body) : ofrepFailure(response.status, body);
}

function ofrepSuccess(body: Record<string, unknown>): OfrepResolutionDetails<unknown> {
  return {
    value: body.value,
    ...(typeof body.variant === "string" ? { variant: body.variant } : {}),
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
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
    errorCode:
      typeof body.errorCode === "string"
        ? body.errorCode
        : status === 404
          ? "FLAG_NOT_FOUND"
          : "GENERAL",
    errorMessage:
      typeof body.errorDetails === "string"
        ? body.errorDetails
        : `OFREP evaluate failed: HTTP ${String(status)}`,
  };
}

function isMetadata(value: unknown): value is Record<string, boolean | string | number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) => typeof entry === "boolean" || typeof entry === "string" || typeof entry === "number",
  );
}

async function withTimeout(
  config: OfrepHttpConfig,
  run: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
