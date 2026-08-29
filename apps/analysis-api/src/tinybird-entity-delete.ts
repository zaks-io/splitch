import {
  type DeleteJob,
  type EntityTinybirdPrivacyScope,
  jobStatus,
  requestJob,
  TinybirdDeleteError,
  waitForJob,
} from "./tinybird-delete";

const ENTITY_DELETION_DATASOURCE = "entity_deletions";
const ENTITY_STORES = [
  ["raw_events", "server_received_at"],
  ["metric_events", "server_received_at"],
  ["deduped_exposures", "first_exposure_ts"],
  ["deduped_metric_events_state", "server_received_at"],
] as const;

interface EntityDeleteOptions {
  fetchFn: typeof fetch;
  apiUrl: string;
  token: string;
  delay: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
  timeoutMs: number;
}

export function createTinybirdEntityDeleteOperations(options: EntityDeleteOptions) {
  return {
    suppressEntity: (scope: EntityTinybirdPrivacyScope) => suppressEntity(scope, options),
    deleteEntity: (scope: EntityTinybirdPrivacyScope) => deleteEntity(scope, options),
  };
}

async function suppressEntity(scope: EntityTinybirdPrivacyScope, options: EntityDeleteOptions) {
  const normalized = normalizedEntityScope(scope);
  const endpoint = new URL("/v0/events", options.apiUrl);
  endpoint.searchParams.set("name", ENTITY_DELETION_DATASOURCE);
  endpoint.searchParams.set("wait", "true");
  const acknowledgement = await appendRows(
    options,
    endpoint,
    normalized.targetingKeyHashes.map((targetingKeyHash) => ({
      app_id: normalized.appId,
      id_type: normalized.idType,
      targeting_key_hash: targetingKeyHash,
      entity_family_hash: normalized.entityFamilyHash,
      delete_before_ts: normalized.deleteBeforeTs,
      requested_at: new Date().toISOString(),
    })),
  );
  return [`${ENTITY_DELETION_DATASOURCE}:successful_rows=${String(acknowledgement)}`];
}

async function deleteEntity(scope: EntityTinybirdPrivacyScope, options: EntityDeleteOptions) {
  const normalized = normalizedEntityScope(scope);
  return Promise.all(
    ENTITY_STORES.map(async ([datasource, timestampColumn]) => {
      const endpoint = new URL(`/v0/datasources/${datasource}/delete`, options.apiUrl);
      const body = new URLSearchParams({
        delete_condition: entityDeleteCondition(normalized, timestampColumn),
      });
      const initial = await requestJob(
        options.fetchFn,
        endpoint,
        options.token,
        { method: "POST", body },
        options.timeoutMs,
      );
      await waitForJob(options.fetchFn, options.apiUrl, options.token, initial, options);
      return `tinybird:${datasource}:${jobProof(initial)}`;
    }),
  );
}

async function appendRows(
  options: EntityDeleteOptions,
  endpoint: URL,
  rows: readonly Record<string, string>[],
): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchFn(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/x-ndjson",
      },
      body: rows.map((row) => JSON.stringify(row)).join("\n"),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new TinybirdDeleteError(
        `Tinybird Entity suppression failed with HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || body.successful_rows !== rows.length || body.quarantined_rows !== 0) {
      throw new TinybirdDeleteError(
        "Tinybird Entity suppression returned an invalid acknowledgement",
      );
    }
    return rows.length;
  } catch (cause) {
    if (cause instanceof TinybirdDeleteError) throw cause;
    throw new TinybirdDeleteError(
      `Tinybird Entity suppression request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedEntityScope(scope: EntityTinybirdPrivacyScope): EntityTinybirdPrivacyScope {
  const targetingKeyHashes = [...new Set(scope.targetingKeyHashes.map((hash) => safeHash(hash)))];
  if (targetingKeyHashes.length === 0) {
    throw new TinybirdDeleteError("Tinybird Entity deletion requires targetingKeyHashes");
  }
  const deleteBeforeMs = Date.parse(scope.deleteBeforeTs);
  if (!Number.isFinite(deleteBeforeMs)) {
    throw new TinybirdDeleteError("Tinybird Entity deletion requires a valid deleteBeforeTs");
  }
  return {
    appId: safeTenantId(scope.appId, "appId"),
    idType: safeTenantId(scope.idType, "idType"),
    targetingKeyHashes,
    entityFamilyHash: safeHash(scope.entityFamilyHash),
    deleteBeforeTs: new Date(deleteBeforeMs).toISOString(),
  };
}

function entityDeleteCondition(scope: EntityTinybirdPrivacyScope, timestampColumn: string): string {
  return [
    `app_id = '${scope.appId}'`,
    `id_type = '${scope.idType}'`,
    `entity_family_hash = '${scope.entityFamilyHash}'`,
    `${timestampColumn} <= parseDateTime64BestEffort('${scope.deleteBeforeTs}')`,
  ].join(" AND ");
}

function safeHash(value: string): string {
  if (!/^(?:local-v1|v1|app-v[1-9]\d*):[a-f0-9]{64}$/u.test(value)) {
    throw new TinybirdDeleteError("Tinybird Entity deletion requires a canonical hash");
  }
  return value;
}

function safeTenantId(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TinybirdDeleteError(`Tinybird Entity deletion requires a safe ${name}`);
  }
  return value;
}

function jobProof(job: DeleteJob): string {
  if (typeof job.job_url === "string") return new URL(job.job_url).pathname;
  if (jobStatus(job) === "done") return "done";
  throw new TinybirdDeleteError("Tinybird Entity deletion omitted its job proof");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
