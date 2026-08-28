import type { AnalysisApiEnv } from "./env";
import {
  appendDeletionSuppression,
  requestJob,
  requiredConfig,
  safeTenantId,
  TinybirdDeleteError,
  waitForJob,
} from "./tinybird-delete";

const STATUS_DATASOURCE = "environment_exposure_status_state";
const DELETION_DATASOURCE = "environment_exposure_status_deletions";

export const APP_IDENTITY_RESET_DATASOURCES = [
  "raw_events",
  "raw_evaluations",
  "metric_events",
  "run_snapshots",
  "deduped_exposures",
  "deduped_metric_events_state",
  STATUS_DATASOURCE,
  "entity_deletions",
  DELETION_DATASOURCE,
] as const;

interface ResetOptions {
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}

export async function deleteAppIdentityData(
  env: AnalysisApiEnv,
  appId: string,
  options: ResetOptions = {},
): Promise<string> {
  const safeAppId = safeTenantId(appId, "appId");
  const apiUrl = requiredConfig(env.TINYBIRD_API_URL, "TINYBIRD_API_URL");
  const token = requiredConfig(env.TINYBIRD_DELETE_TOKEN, "TINYBIRD_DELETE_TOKEN");
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const wait = {
    delay:
      options.delay ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    pollIntervalMs: options.pollIntervalMs ?? 250,
    timeoutMs,
  };

  await appendDeletionSuppression(fetchFn, apiUrl, token, { appId: safeAppId }, timeoutMs);
  await requireRowCount(fetchFn, apiUrl, token, DELETION_DATASOURCE, safeAppId, timeoutMs, {
    environmentId: "",
    minimum: 1,
  });

  const proofs = ["suppression=visible", "audit_log=retained"];
  for (const datasource of APP_IDENTITY_RESET_DATASOURCES) {
    if (datasource === DELETION_DATASOURCE) continue;
    await deleteDatasourceRows(fetchFn, apiUrl, token, datasource, safeAppId, timeoutMs, wait);
    await requireRowCount(fetchFn, apiUrl, token, datasource, safeAppId, timeoutMs, { exact: 0 });
    proofs.push(`${datasource}=0`);
  }

  await requireRowCount(fetchFn, apiUrl, token, STATUS_DATASOURCE, safeAppId, timeoutMs, {
    exact: 0,
  });
  proofs.push("status-stable=0");
  await deleteDatasourceRows(
    fetchFn,
    apiUrl,
    token,
    DELETION_DATASOURCE,
    safeAppId,
    timeoutMs,
    wait,
  );
  await requireRowCount(fetchFn, apiUrl, token, DELETION_DATASOURCE, safeAppId, timeoutMs, {
    exact: 0,
  });
  proofs.push(`${DELETION_DATASOURCE}=0`);
  return `tinybird-app-identity-reset:${proofs.join(",")}`;
}

async function deleteDatasourceRows(
  fetchFn: typeof fetch,
  apiUrl: string,
  token: string,
  datasource: string,
  appId: string,
  timeoutMs: number,
  wait: Parameters<typeof waitForJob>[4],
): Promise<void> {
  const endpoint = new URL(`/v0/datasources/${datasource}/delete`, apiUrl);
  const body = new URLSearchParams({ delete_condition: `app_id = '${appId}'` });
  const job = await requestJob(fetchFn, endpoint, token, { method: "POST", body }, timeoutMs);
  await waitForJob(fetchFn, apiUrl, token, job, wait);
}

async function requireRowCount(
  fetchFn: typeof fetch,
  apiUrl: string,
  token: string,
  datasource: string,
  appId: string,
  timeoutMs: number,
  expected: { exact: number } | { environmentId: string; minimum: number },
): Promise<void> {
  const condition =
    "environmentId" in expected
      ? `app_id = '${appId}' AND environment_id = '${expected.environmentId}'`
      : `app_id = '${appId}'`;
  const endpoint = new URL("/v0/sql", apiUrl);
  endpoint.searchParams.set(
    "q",
    `SELECT count() AS remaining_rows FROM ${datasource} WHERE ${condition} FORMAT JSON`,
  );
  const response = await requestJson(fetchFn, endpoint, token, timeoutMs);
  const count = readRowCount(response);
  const valid = "exact" in expected ? count === expected.exact : count >= expected.minimum;
  if (!valid) {
    throw new TinybirdDeleteError(
      `Tinybird App identity reset proof failed for ${datasource}: remaining_rows=${count}`,
    );
  }
}

async function requestJson(
  fetchFn: typeof fetch,
  endpoint: URL,
  token: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new TinybirdDeleteError(
        `Tinybird App identity reset proof failed with HTTP ${response.status}`,
      );
    }
    return response.json();
  } catch (cause) {
    if (cause instanceof TinybirdDeleteError) throw cause;
    throw new TinybirdDeleteError(
      `Tinybird App identity reset proof request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function readRowCount(value: unknown): number {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    throw new TinybirdDeleteError("Tinybird App identity reset proof returned invalid JSON");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== 1) {
    throw new TinybirdDeleteError("Tinybird App identity reset proof returned invalid rows");
  }
  const row = data[0];
  if (typeof row !== "object" || row === null || !("remaining_rows" in row)) {
    throw new TinybirdDeleteError("Tinybird App identity reset proof omitted remaining_rows");
  }
  const count = (row as { remaining_rows?: unknown }).remaining_rows;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new TinybirdDeleteError("Tinybird App identity reset proof returned an invalid count");
  }
  return count as number;
}
