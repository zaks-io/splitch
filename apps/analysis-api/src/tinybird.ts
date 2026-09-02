import type { AnalysisApiEnv } from "./env";
import {
  createPerformanceSpanRecorder,
  type PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";

export type PipeParams = Record<string, string>;
export type TinybirdReadOptions = { method: "GET" | "POST" };

export interface TinybirdReadTransport {
  readPipe(
    pipeName: string,
    params: PipeParams,
    options?: TinybirdReadOptions,
  ): Promise<readonly unknown[]>;
}

export interface TinybirdCopyTransport {
  runCopyPipe(pipeName: string, params: PipeParams): Promise<void>;
}

const DEFAULT_TINYBIRD_TIMEOUT_MS = 5_000;

export class TinybirdReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TinybirdReadError";
  }
}

export class TinybirdCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TinybirdCopyError";
  }
}

const DATETIME64_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/**
 * Tinybird's DateTime64 template type rejects ISO 8601 ("2026-08-01T00:00:00.000Z")
 * with HTTP 400 TYPE_MISMATCH; it accepts "2026-08-01 00:00:00.000" (UTC). Every
 * DateTime parameter crosses here so a call site cannot ship the ISO form again.
 */
export function tinybirdDateTime64(isoUtc: string): string {
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) {
    throw new Error(`analysis-api: "${isoUtc}" is not a timestamp Tinybird DateTime64 can carry`);
  }
  const value = new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  if (!DATETIME64_PATTERN.test(value)) {
    throw new Error(`analysis-api: "${isoUtc}" is not a timestamp Tinybird DateTime64 can carry`);
  }
  return value;
}

export function scopedPipeParams(input: {
  appId: string | null | undefined;
  environmentId: string | null | undefined;
  experimentId?: string | null | undefined;
  runId?: string | null | undefined;
}): PipeParams {
  const appId = requiredParam(input.appId, "app_id");
  const environmentId = requiredParam(input.environmentId, "environment_id");
  return {
    app_id: appId,
    environment_id: environmentId,
    ...(input.experimentId ? { experiment_id: input.experimentId } : {}),
    ...(input.runId ? { run_id: input.runId } : {}),
  };
}

export function scopedUsagePipeParams(input: {
  organizationId: string | null | undefined;
  periodStart: string;
  periodEnd: string;
}): PipeParams {
  return {
    organization_id: requiredParam(input.organizationId, "organization_id"),
    period_start: tinybirdDateTime64(requiredParam(input.periodStart, "period_start")),
    period_end: tinybirdDateTime64(requiredParam(input.periodEnd, "period_end")),
  };
}

export function createTinybirdReadTransport(
  env: AnalysisApiEnv,
  opts: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    spanRecorder?: PerformanceSpanRecorder;
  } = {},
): TinybirdReadTransport {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TINYBIRD_TIMEOUT_MS;
  const apiUrl = requiredConfig(env.TINYBIRD_API_URL, "TINYBIRD_API_URL");
  const spans = opts.spanRecorder ?? createPerformanceSpanRecorder(env);

  return {
    async readPipe(pipeName, params, options = { method: "GET" }) {
      return spans.record(tinybirdSpan(pipeName, "read", options.method), async (span) => {
        assertScoped(params);
        const request = pipeRequest(apiUrl, pipeName, params, options);
        const response = await fetchWithTimeout(
          fetchFn,
          request.url,
          requiredReadToken(env),
          timeoutMs,
          "pipe read",
          request.init,
        );
        span.setAttribute("http.response.status_code", response.status);
        if (!response.ok) {
          throw new TinybirdReadError(`Tinybird pipe read failed with HTTP ${response.status}`);
        }

        const rows = parseRows(await responseBody(response));
        span.setAttribute("db.response.returned_rows", rows.length);
        return rows;
      });
    },
  };
}

export function createTinybirdCopyTransport(
  env: AnalysisApiEnv,
  opts: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    spanRecorder?: PerformanceSpanRecorder;
  } = {},
): TinybirdCopyTransport {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TINYBIRD_TIMEOUT_MS;
  const apiUrl = requiredConfig(env.TINYBIRD_API_URL, "TINYBIRD_API_URL");
  const spans = opts.spanRecorder ?? createPerformanceSpanRecorder(env);

  return {
    async runCopyPipe(pipeName, params) {
      return spans.record(tinybirdSpan(pipeName, "copy", "POST"), async (span) => {
        const response = await fetchWithTimeout(
          fetchFn,
          copyPipeUrl(apiUrl, pipeName, params),
          requiredCopyToken(env),
          timeoutMs,
          "copy run",
          { method: "POST" },
        );
        span.setAttribute("http.response.status_code", response.status);
        if (!response.ok) {
          throw new TinybirdCopyError(`Tinybird copy run failed with HTTP ${response.status}`);
        }
      });
    },
  };
}

function tinybirdSpan(pipeName: string, operation: "read" | "copy", method: "GET" | "POST") {
  return {
    name: `Tinybird ${operation} ${pipeName}`,
    op: "http.client",
    attributes: {
      "db.system": "tinybird",
      "db.operation.name": operation,
      "http.request.method": method,
      "tinybird.pipe.name": pipeName,
    },
  } as const;
}

function requiredReadToken(env: AnalysisApiEnv): string {
  const token = env.TINYBIRD_READ_TOKEN;
  if (!token) {
    throw new TinybirdReadError("Tinybird read token is unavailable");
  }
  return token;
}

function requiredCopyToken(env: AnalysisApiEnv): string {
  const token = env.TINYBIRD_COPY_TOKEN;
  if (!token) {
    throw new TinybirdCopyError("Tinybird copy token is unavailable");
  }
  return token;
}

function pipeUrl(apiUrl: string, pipeName: string, params: PipeParams): URL {
  const url = new URL(`/v0/pipes/${pipeName}.json`, apiUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function pipeRequest(
  apiUrl: string,
  pipeName: string,
  params: PipeParams,
  options: TinybirdReadOptions,
): { url: URL; init: RequestInit } {
  if (options.method === "GET") return { url: pipeUrl(apiUrl, pipeName, params), init: {} };
  return {
    url: pipeUrl(apiUrl, pipeName, {}),
    init: { method: "POST", body: new URLSearchParams(params) },
  };
}

function copyPipeUrl(apiUrl: string, pipeName: string, params: PipeParams): URL {
  const url = new URL(`/v0/pipes/${pipeName}/copy`, apiUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function responseBody(response: Response): Promise<{ data?: unknown }> {
  try {
    return (await response.json()) as { data?: unknown };
  } catch (cause) {
    throw new TinybirdReadError(`Tinybird pipe read returned invalid JSON: ${errorMessage(cause)}`);
  }
}

function parseRows(body: { data?: unknown }): readonly unknown[] {
  if (!Array.isArray(body.data)) {
    throw new TinybirdReadError("Tinybird pipe read returned a malformed payload");
  }
  return body.data;
}

function assertScoped(params: PipeParams): void {
  if (params.entity_family_hash !== undefined || params.id_type !== undefined) {
    requiredParam(params.app_id, "app_id");
    requiredParam(params.id_type, "id_type");
    requiredParam(params.entity_family_hash, "entity_family_hash");
    if (params.environment_id !== undefined || params.organization_id !== undefined) {
      throw new TinybirdReadError("Tinybird Entity pipe scope cannot mix tenant axes");
    }
    return;
  }
  if (
    params.organization_id !== undefined ||
    params.period_start !== undefined ||
    params.period_end !== undefined
  ) {
    if (params.app_id !== undefined || params.environment_id !== undefined) {
      throw new TinybirdReadError("Tinybird pipe scopes cannot mix Organization and App axes");
    }
    requiredParam(params.organization_id, "organization_id");
    requiredParam(params.period_start, "period_start");
    requiredParam(params.period_end, "period_end");
    return;
  }
  requiredParam(params.app_id, "app_id");
  requiredParam(params.environment_id, "environment_id");
}

function requiredConfig(value: string | null | undefined, name: string): string {
  if (value === undefined || value === null || value.trim().length === 0) {
    throw new TinybirdReadError(`Tinybird config ${name} is required`);
  }
  return value;
}

function requiredParam(value: string | null | undefined, name: string): string {
  if (value === undefined || value === null || value.trim().length === 0) {
    throw new TinybirdReadError(`Tinybird pipe parameter ${name} is required`);
  }
  return value;
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: URL,
  token: string,
  timeoutMs: number,
  kind: "pipe read" | "copy run",
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return await fetchFn(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (cause) {
    throw tinybirdRequestError(kind, `Tinybird ${kind} failed: ${errorMessage(cause)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function tinybirdRequestError(kind: "pipe read" | "copy run", message: string): Error {
  return kind === "pipe read" ? new TinybirdReadError(message) : new TinybirdCopyError(message);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
