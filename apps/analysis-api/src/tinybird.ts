import type { AnalysisApiEnv } from "./env.js";

export type PipeParams = Record<string, string>;

export interface TinybirdReadTransport {
  readPipe(pipeName: string, params: PipeParams): Promise<readonly unknown[]>;
}

export class TinybirdReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TinybirdReadError";
  }
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

export function createTinybirdReadTransport(env: AnalysisApiEnv): TinybirdReadTransport {
  return {
    async readPipe(pipeName, params) {
      assertAppScoped(params);
      const token = env.TINYBIRD_READ_TOKEN;
      if (!token) {
        throw new TinybirdReadError("Tinybird read token is unavailable");
      }

      const url = new URL(
        `/v0/pipes/${pipeName}.json`,
        env.TINYBIRD_API_URL ?? "https://api.tinybird.co",
      );
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new TinybirdReadError(`Tinybird pipe read failed with HTTP ${response.status}`);
      }

      const body = (await response.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) {
        throw new TinybirdReadError("Tinybird pipe read returned a malformed payload");
      }
      return body.data;
    },
  };
}

function assertAppScoped(params: PipeParams): void {
  requiredParam(params.app_id, "app_id");
}

function requiredParam(value: string | null | undefined, name: string): string {
  if (value === undefined || value === null || value.trim().length === 0) {
    throw new TinybirdReadError(`Tinybird pipe parameter ${name} is required`);
  }
  return value;
}
