import type { AnalysisApiEnv } from "./env";
import { createTinybirdEntityDeleteOperations } from "./tinybird-entity-delete";

const STATUS_DATASOURCE = "environment_exposure_status_state";
const DELETION_DATASOURCE = "environment_exposure_status_deletions";
const SAFE_TENANT_ID = /^[A-Za-z0-9_-]+$/u;
const TERMINAL_FAILURES = new Set(["cancelled", "error", "failed"]);

export interface ExposureStatusDeleteScope {
  appId: string;
  environmentId?: string;
}

export interface TinybirdDeleteTransport {
  deleteExposureStatus(scope: ExposureStatusDeleteScope): Promise<void>;
  suppressEntity?(scope: EntityTinybirdPrivacyScope): Promise<readonly string[]>;
  deleteEntity?(scope: EntityTinybirdPrivacyScope): Promise<readonly string[]>;
}

export interface EntityTinybirdPrivacyScope {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  entityFamilyHash: string;
  deleteBeforeTs: string;
}

export class TinybirdDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TinybirdDeleteError";
  }
}

export function createTinybirdDeleteTransport(
  env: AnalysisApiEnv,
  options: {
    fetchFn?: typeof fetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
  } = {},
): TinybirdDeleteTransport {
  const fetchFn = options.fetchFn ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  const entityOperations = () =>
    createTinybirdEntityDeleteOperations({
      fetchFn,
      apiUrl: requiredConfig(env.TINYBIRD_API_URL, "TINYBIRD_API_URL"),
      token: requiredConfig(env.TINYBIRD_DELETE_TOKEN, "TINYBIRD_DELETE_TOKEN"),
      delay,
      pollIntervalMs,
      timeoutMs,
    });
  return {
    async deleteExposureStatus(scope) {
      const apiUrl = requiredConfig(env.TINYBIRD_API_URL, "TINYBIRD_API_URL");
      const token = requiredConfig(env.TINYBIRD_DELETE_TOKEN, "TINYBIRD_DELETE_TOKEN");
      const condition = deleteCondition(scope);
      await appendDeletionSuppression(fetchFn, apiUrl, token, scope, timeoutMs);
      const endpoint = new URL(`/v0/datasources/${STATUS_DATASOURCE}/delete`, apiUrl);
      const body = new URLSearchParams({ delete_condition: condition });
      const job = await requestJob(fetchFn, endpoint, token, { method: "POST", body }, timeoutMs);
      await waitForJob(fetchFn, apiUrl, token, job, { delay, pollIntervalMs, timeoutMs });
    },
    suppressEntity: (scope) => entityOperations().suppressEntity(scope),
    deleteEntity: (scope) => entityOperations().deleteEntity(scope),
  };
}

async function appendDeletionSuppression(
  fetchFn: typeof fetch,
  apiUrl: string,
  token: string,
  scope: ExposureStatusDeleteScope,
  timeoutMs: number,
): Promise<void> {
  const appId = safeTenantId(scope.appId, "appId");
  const environmentId =
    scope.environmentId === undefined ? "" : safeTenantId(scope.environmentId, "environmentId");
  const endpoint = new URL("/v0/events", apiUrl);
  endpoint.searchParams.set("name", DELETION_DATASOURCE);
  endpoint.searchParams.set("wait", "true");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ app_id: appId, environment_id: environmentId }),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new TinybirdDeleteError(
        `Tinybird Exposure status suppression failed with HTTP ${response.status}`,
      );
    }
    const acknowledgement = (await response.json()) as unknown;
    if (
      !isRecord(acknowledgement) ||
      acknowledgement.successful_rows !== 1 ||
      acknowledgement.quarantined_rows !== 0
    ) {
      throw new TinybirdDeleteError(
        "Tinybird Exposure status suppression returned an invalid acknowledgement",
      );
    }
  } catch (cause) {
    if (cause instanceof TinybirdDeleteError) throw cause;
    throw new TinybirdDeleteError(
      `Tinybird Exposure status suppression request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deleteCondition(scope: ExposureStatusDeleteScope): string {
  const appId = safeTenantId(scope.appId, "appId");
  const appCondition = `app_id = '${appId}'`;
  if (scope.environmentId === undefined) return appCondition;
  return `${appCondition} AND environment_id = '${safeTenantId(scope.environmentId, "environmentId")}'`;
}

export async function waitForJob(
  fetchFn: typeof fetch,
  apiUrl: string,
  token: string,
  initial: DeleteJob,
  options: {
    delay: (milliseconds: number) => Promise<void>;
    pollIntervalMs: number;
    timeoutMs: number;
  },
): Promise<void> {
  let job = initial;
  const deadline = Date.now() + options.timeoutMs;
  while (jobStatus(job) !== "done") {
    const status = jobStatus(job);
    if (status && TERMINAL_FAILURES.has(status)) {
      throw new TinybirdDeleteError(`Tinybird Exposure status deletion job ${status}`);
    }
    if (Date.now() >= deadline) {
      throw new TinybirdDeleteError("Tinybird Exposure status deletion timed out");
    }
    const jobUrl = validatedJobUrl(job, apiUrl);
    await options.delay(options.pollIntervalMs);
    job = await requestJob(fetchFn, jobUrl, token, { method: "GET" }, options.timeoutMs);
  }
}

export interface DeleteJob {
  status?: unknown;
  job_url?: unknown;
  job?: { status?: unknown };
}

export async function requestJob(
  fetchFn: typeof fetch,
  url: URL,
  token: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<DeleteJob> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      ...init,
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new TinybirdDeleteError(
        `Tinybird Exposure status deletion failed with HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as DeleteJob;
    if (!body || typeof body !== "object") {
      throw new TinybirdDeleteError("Tinybird Exposure status deletion returned an invalid job");
    }
    return body;
  } catch (cause) {
    if (cause instanceof TinybirdDeleteError) throw cause;
    throw new TinybirdDeleteError(
      `Tinybird Exposure status deletion request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function jobStatus(job: DeleteJob): string | null {
  const status = job.status ?? job.job?.status;
  return typeof status === "string" ? status.toLowerCase() : null;
}

function validatedJobUrl(job: DeleteJob, apiUrl: string): URL {
  if (typeof job.job_url !== "string") {
    throw new TinybirdDeleteError("Tinybird Exposure status deletion omitted its job URL");
  }
  const url = new URL(job.job_url);
  const expected = new URL(apiUrl);
  if (url.origin !== expected.origin || !url.pathname.startsWith("/v0/jobs/")) {
    throw new TinybirdDeleteError("Tinybird Exposure status deletion returned an invalid job URL");
  }
  return url;
}

function safeTenantId(value: string, name: string): string {
  if (!SAFE_TENANT_ID.test(value)) {
    throw new TinybirdDeleteError(`Tinybird Exposure status deletion requires a safe ${name}`);
  }
  return value;
}

function requiredConfig(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new TinybirdDeleteError(`Tinybird config ${name} is required`);
  return value;
}
