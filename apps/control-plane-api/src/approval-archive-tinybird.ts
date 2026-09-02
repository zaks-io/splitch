import type {
  ApprovalArchiveEvent,
  ApprovalArchiveQuery,
  ApprovalArchiveStore,
} from "./approval-archive";
import { APPROVAL_ARCHIVE_VERSION } from "./approval-archive";
import { createPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import type { ControlPlaneApiEnv } from "./env";

const PIPE_NAME = "approval_request_archives";
const DATASOURCE_NAME = "audit_log";

export function approvalArchiveStoreFromEnv(
  env: ControlPlaneApiEnv,
  fetchFn: typeof fetch = fetch,
): ApprovalArchiveStore {
  const spans = createPerformanceSpanRecorder(env);
  return {
    async append(event) {
      const response = await fetchFn(eventsUrl(requiredApiUrl(env)), {
        method: "POST",
        headers: {
          authorization: `Bearer ${requiredToken(env.TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN, "write")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
      });
      if (response.status !== 200) {
        throw new Error(
          `Tinybird Approval Request archive append failed with HTTP ${response.status}`,
        );
      }
      const body = (await response.json().catch(() => null)) as {
        successful_rows?: number;
        quarantined_rows?: number;
      } | null;
      if (!body) {
        throw new Error("Tinybird Approval Request archive append acknowledgment is malformed");
      }
      if (body.successful_rows !== 1 || body.quarantined_rows !== 0) {
        throw new Error(
          `Tinybird Approval Request archive append mismatch (successful=${body.successful_rows}, quarantined=${body.quarantined_rows})`,
        );
      }
    },

    async get(appId, requestId, archiveVersion) {
      const rows = await readRows(
        env,
        fetchFn,
        pipeParams({ appId, requestId, limit: 1 }, { archive_version: String(archiveVersion) }),
        spans,
      );
      const row = rows[0];
      return row ? parseArchiveEvent(row) : null;
    },

    async list(query) {
      const rows = await readRows(env, fetchFn, pipeParams(query), spans);
      return rows.map(parseArchiveEvent);
    },
  };
}

function pipeParams(
  query: ApprovalArchiveQuery,
  extra: Record<string, string> = {},
): URLSearchParams {
  if (!query.appId) throw new Error("Approval Request archive read requires an App scope");
  const params = new URLSearchParams({ app_id: query.appId, limit: String(query.limit), ...extra });
  if (query.requestId) params.set("request_id", query.requestId);
  if (query.status) params.set("status", query.status);
  if (query.targetType) params.set("target_type", query.targetType);
  if (query.environmentId) params.set("environment_id", query.environmentId);
  if (query.after) {
    params.set("after_proposed_at", tinybirdDateTime(query.after.proposedAt));
    params.set("after_request_id", query.after.id);
  }
  return params;
}

async function readRows(
  env: ControlPlaneApiEnv,
  fetchFn: typeof fetch,
  params: URLSearchParams,
  spans: ReturnType<typeof createPerformanceSpanRecorder>,
): Promise<unknown[]> {
  return spans.record(
    {
      name: `Tinybird read ${PIPE_NAME}`,
      op: "http.client",
      attributes: {
        "db.system": "tinybird",
        "db.operation.name": "read",
        "http.request.method": "GET",
        "tinybird.pipe.name": PIPE_NAME,
      },
    },
    async (span) => {
      const url = new URL(`/v0/pipes/${PIPE_NAME}.json`, requiredApiUrl(env));
      url.search = params.toString();
      const response = await fetchFn(url, {
        headers: {
          authorization: `Bearer ${requiredToken(env.TINYBIRD_APPROVAL_ARCHIVE_READ_TOKEN, "read")}`,
        },
      });
      span.setAttribute("http.response.status_code", response.status);
      if (!response.ok) {
        throw new Error(
          `Tinybird Approval Request archive read failed with HTTP ${response.status}`,
        );
      }
      const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
      if (!body || !Array.isArray(body.data)) {
        throw new Error("Tinybird Approval Request archive read returned a malformed payload");
      }
      span.setAttribute("db.response.returned_rows", body.data.length);
      return body.data;
    },
  );
}

function parseArchiveEvent(value: unknown): ApprovalArchiveEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tinybird Approval Request archive row is malformed");
  }
  const row = value as Record<string, unknown>;
  const archiveVersion = integer(row.archive_version, "archive_version");
  const archivedD1RowCount = integer(row.archived_d1_row_count, "archived_d1_row_count");
  const event = {
    audit_id: string(row.audit_id, "audit_id"),
    dedup_key: string(row.dedup_key, "dedup_key"),
    app_id: string(row.app_id, "app_id"),
    user_id: string(row.user_id, "user_id"),
    auth_method: string(row.auth_method, "auth_method"),
    action: string(row.action, "action"),
    resource_type: string(row.resource_type, "resource_type"),
    resource_id: string(row.resource_id, "resource_id"),
    changes: string(row.changes, "changes"),
    timestamp: string(row.timestamp, "timestamp"),
    archive_version: archiveVersion,
    archived_d1_row_count: archivedD1RowCount,
    archive_checksum: string(row.archive_checksum, "archive_checksum"),
    request_status: string(row.request_status, "request_status"),
    target_type: string(row.target_type, "target_type"),
    proposed_at: string(row.proposed_at, "proposed_at"),
    resolved_at: string(row.resolved_at, "resolved_at"),
    policy_contexts: string(row.policy_contexts, "policy_contexts"),
  };
  if (
    event.action !== "approval_request.archive" ||
    event.resource_type !== "approval_request" ||
    event.archive_version !== APPROVAL_ARCHIVE_VERSION ||
    (event.request_status !== "applied" &&
      event.request_status !== "declined" &&
      event.request_status !== "stale")
  ) {
    throw new Error("Tinybird Approval Request archive row is malformed");
  }
  return event as ApprovalArchiveEvent;
}

function eventsUrl(apiUrl: string): URL {
  const url = new URL("/v0/events", apiUrl);
  url.searchParams.set("name", DATASOURCE_NAME);
  url.searchParams.set("wait", "true");
  return url;
}

function requiredApiUrl(env: ControlPlaneApiEnv): string {
  if (!env.TINYBIRD_API_URL)
    throw new Error("Tinybird Approval Request archive API URL is unavailable");
  return env.TINYBIRD_API_URL;
}

function requiredToken(value: string | undefined, kind: "read" | "write"): string {
  if (!value) throw new Error(`Tinybird Approval Request archive ${kind} token is unavailable`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Tinybird archive ${field} is malformed`);
  return value;
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Tinybird archive ${field} is malformed`);
  }
  return parsed;
}

function tinybirdDateTime(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms))
    throw new Error(`Approval Request cursor timestamp ${value} is invalid`);
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}
