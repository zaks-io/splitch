import {
  AppAuditChangesSchema,
  type AppAuditEvent,
  AppAuditEventSchema,
  type AppAuditListQuery,
  AppAuditListQuerySchema,
  type AppAuditListResponse,
  AppAuditListResponseSchema,
  AppAuditStorageRowSchema,
  canonicalJson,
  LIST_READ_LIMIT,
} from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { decodeAuditCursor, encodeAuditCursor, InvalidAuditPagination } from "./app-audit-cursor";
import { rowObject, stringField } from "./results-row-fields";
import { TinybirdReadError, type TinybirdReadTransport, tinybirdDateTime64 } from "./tinybird";

export function makeAppAuditHandler(deps: { tinybird: TinybirdReadTransport }) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const parts = rowObject(input);
      const appId = stringField(rowObject(parts.params), "appId");
      if (principal.appId !== appId) {
        return renderError(
          { code: "FORBIDDEN", message: "Credential is not scoped to this App", details: {} },
          { requestId },
        );
      }
      return Response.json(
        await readAppAudit(deps.tinybird, appId, AppAuditListQuerySchema.parse(parts.query)),
      );
    } catch (cause) {
      if (cause instanceof InvalidAuditPagination) {
        return renderError(
          {
            code: "INVALID_PAGINATION",
            message: cause.message,
            details: { field: "cursor", reason: "Cursor does not match this App and filters" },
          },
          { requestId },
        );
      }
      if (cause instanceof TinybirdReadError) {
        return renderError(
          {
            code: "SERVICE_UNAVAILABLE",
            message: "App audit is unavailable",
            details: { retryAfterMs: 30_000 },
          },
          { requestId },
        );
      }
      return renderError(
        { code: "INTERNAL_SERVER_ERROR", message: "App audit read failed validation", details: {} },
        { requestId },
      );
    }
  };
}

/** Reusable provider boundary for real local Tinybird integration tests. */
export async function readAppAudit(
  tinybird: TinybirdReadTransport,
  appId: string,
  query: AppAuditListQuery,
): Promise<AppAuditListResponse> {
  const position = decodeAuditCursor(appId, query);
  const readLimit = Math.min(query.limit, LIST_READ_LIMIT);
  const params = auditPipeParams(appId, query, readLimit);
  const rows = await tinybird.readPipe("app_audit_events", params);
  if (rows.length > readLimit + 1) throw new Error("App audit exceeded its read limit");
  const events = rows.map((row) => projectAuditEvent(row, appId));
  assertEventOrder(events, position);
  const readTruncated = events.length > readLimit;
  const items = events.slice(0, readLimit);
  const last = items.at(-1);
  return AppAuditListResponseSchema.parse({
    items,
    readLimit,
    readTruncated,
    cursor: readTruncated && last ? encodeAuditCursor(appId, query, last) : null,
  });
}

function auditPipeParams(
  appId: string,
  query: AppAuditListQuery,
  readLimit: number,
): Record<string, string> {
  if (!appId.trim()) throw new Error("App audit requires app_id");
  const position = decodeAuditCursor(appId, query);
  const params: Record<string, string> = { app_id: appId, limit: String(readLimit + 1) };
  const filters = {
    environment_id: query.environmentId,
    action: query.action,
    resource_type: query.resourceType,
    resource_id: query.resourceId,
    approval_request_id: query.approvalRequestId,
    run_id: query.runId,
    from_timestamp: optionalTimestamp(query.from),
    to_timestamp: optionalTimestamp(query.to),
    after_timestamp: optionalTimestamp(position?.timestamp),
    after_event_id: position?.eventId,
  };
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params[key] = value;
  }
  return params;
}

function optionalTimestamp(value: string | undefined): string | undefined {
  return value === undefined ? undefined : tinybirdDateTime64(value);
}

function assertEventOrder(
  events: AppAuditEvent[],
  position: Pick<AppAuditEvent, "eventId" | "timestamp"> | null,
): void {
  let previous = position;
  for (const event of events) {
    if (previous && !isBefore(event, previous))
      throw new Error("App audit returned duplicate or unordered events");
    previous = event;
  }
}

function isBefore(
  event: Pick<AppAuditEvent, "eventId" | "timestamp">,
  previous: Pick<AppAuditEvent, "eventId" | "timestamp">,
): boolean {
  return (
    event.timestamp < previous.timestamp ||
    (event.timestamp === previous.timestamp && event.eventId < previous.eventId)
  );
}

function projectAuditEvent(value: unknown, appId: string): AppAuditEvent {
  const row = AppAuditStorageRowSchema.parse(value);
  if (row.app_id !== appId || row.audit_id !== row.dedup_key) {
    throw new Error("App audit identity or isolation failure");
  }
  const changes = AppAuditChangesSchema.parse(JSON.parse(row.changes));
  if (canonicalJson(changes) !== row.changes)
    throw new Error("App audit changes are not canonical JSON");
  const timestamp = `${row.timestamp.replace(" ", "T")}Z`;
  const unattributed = row.user_id === null || row.user_id === "unattributed";
  return AppAuditEventSchema.parse({
    ...changes,
    eventId: row.audit_id,
    appId: row.app_id,
    actor: unattributed
      ? { type: "unattributed", userId: null }
      : { type: "user", userId: row.user_id },
    authDoor: row.auth_method,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    timestamp,
  });
}
