import type { ApprovalRequest } from "@splitch/contracts";
import { type ApprovalCommit, appScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { requireAppMember } from "./app-authz";
import {
  APPROVAL_ARCHIVE_VERSION,
  type ApprovalArchiveStore,
  archivedApprovalRequest,
} from "./approval-archive";
import { approvalRequestProjection } from "./approval-model";
import { reviewApproval } from "./approval-service";
import type { ApplicationOutcome } from "./approval-service-types";
import type { ConfigStoreAccess } from "./config-store-do";
import { objectBody, pathParam } from "./handler-input";

interface ApprovalHandlerDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  nowIso?: () => string;
  applyOther?: (request: ApprovalRequest, commit: ApprovalCommit) => Promise<ApplicationOutcome>;
  archiveStore?: ApprovalArchiveStore;
}

interface ApprovalListQuery {
  status?: string;
  target_kind?: string;
  environmentId?: string;
  limit?: number;
  cursor?: string | null;
}

export function makeApprovalHandlers(deps: ApprovalHandlerDeps) {
  return {
    async list({ input, principal, requestId }: HandlerArgs<unknown>) {
      const appId = pathParam(input, "appId");
      const memberError = await requireAppMember(deps, appId, principal, requestId);
      if (memberError) return memberError;
      const query = queryInput(input);
      return listApprovalRequests(deps, appId, query, requestId);
    },

    async get({ input, principal, requestId }: HandlerArgs<unknown>) {
      const appId = pathParam(input, "appId");
      const memberError = await requireAppMember(deps, appId, principal, requestId);
      if (memberError) return memberError;
      const row = await deps.repo.approvals.getRequest(appScope(appId), pathParam(input, "id"));
      if (row) return Response.json(await approvalRequestProjection(deps.repo, row));
      const archived = await deps.archiveStore?.get(
        appId,
        pathParam(input, "id"),
        APPROVAL_ARCHIVE_VERSION,
      );
      return archived
        ? Response.json(await archivedApprovalRequest(archived, appId))
        : approvalNotFound(requestId);
    },

    async review({ input, principal, requestId }: HandlerArgs<unknown>) {
      const appId = pathParam(input, "appId");
      const memberError = await requireAppMember(deps, appId, principal, requestId);
      if (memberError) return memberError;
      const body = objectBody(input);
      const reviewed = await reviewApproval(deps, {
        appId,
        approvalRequestId: pathParam(input, "id"),
        action: body.action as "approve_and_apply" | "decline",
        reason: typeof body.reason === "string" ? body.reason : null,
        idempotencyKey: body.idempotency_key as string,
        principal,
        requestId,
      });
      return reviewed.ok ? Response.json(reviewed.approvalRequest) : reviewed.response;
    },
  };
}

async function listApprovalRequests(
  deps: ApprovalHandlerDeps,
  appId: string,
  query: ApprovalListQuery,
  requestId: string,
): Promise<Response> {
  const limit = query.limit ?? 50;
  const scope = appScope(appId);
  const after = query.cursor
    ? await resolveCursor(deps, appId, query.cursor, archiveCanMatch(query.status))
    : undefined;
  if (query.cursor && !after) {
    return renderError(
      {
        code: "INVALID_PAGINATION",
        message: "pagination cursor is not valid for this Approval Request query",
        details: { field: "cursor", reason: "unknown cursor" },
      },
      { requestId },
    );
  }
  // Effective staleness is derived per row, so only `pending` requests can
  // render as either `pending` or `stale`. Both filters therefore push the same
  // stored predicate down and reconcile against the projection afterwards.
  const effectiveOnly = query.status === "pending" || query.status === "stale";
  const filters = {
    storedStatus: statusFilter(query.status),
    targetType: query.target_kind,
    environmentId: query.environmentId,
  };
  const cursor = after ? { proposedAt: after.proposedAt, id: after.id } : undefined;
  const page = await mergedRequestPage(deps, appId, query, filters, cursor, limit);
  return Response.json({
    items: page.items,
    cursor: page.cursor,
    limit,
    readLimit: limit,
    readTruncated: page.cursor !== null,
    // Production lists merge D1 and Tinybird, so an exact count is not computed.
    // Pending/stale filters additionally resolve effective status after projection.
    // `index.ts` always passes an `archiveStore` (approvalArchiveStoreFromEnv
    // never returns undefined), so in production `deps.archiveStore` is always
    // truthy and this expression always takes the `null` branch. The
    // `countRequests` call below only runs in tests whose harness omits the
    // store — it is not reachable in production.
    total:
      effectiveOnly || deps.archiveStore
        ? null
        : await deps.repo.approvals.countRequests(scope, filters),
  });
}

async function mergedRequestPage(
  deps: ApprovalHandlerDeps,
  appId: string,
  query: ApprovalListQuery,
  filters: { storedStatus?: readonly string[]; targetType?: string; environmentId?: string },
  cursor: { proposedAt: string; id: string } | undefined,
  limit: number,
): Promise<{ items: ApprovalRequest[]; cursor: string | null }> {
  const scanLimit = limit + 1;
  const onlineQuery = { ...filters, limit: scanLimit, ...(cursor ? { after: cursor } : {}) };
  const [rows, archiveEvents] = await Promise.all([
    deps.repo.approvals.listRequestPage(appScope(appId), onlineQuery),
    archiveRequestPage(deps.archiveStore, appId, query, cursor, scanLimit),
  ]);
  const [online, archived] = await Promise.all([
    Promise.all(rows.map((row) => approvalRequestProjection(deps.repo, row))),
    Promise.all(archiveEvents.map((event) => archivedApprovalRequest(event, appId))),
  ]);
  const scanned = [...online, ...archived]
    .sort(compareRequests)
    .filter((request, index, all) => all.findIndex((item) => item.id === request.id) === index);
  const window = scanned.slice(0, limit);
  return {
    items: window.filter((request) => !query.status || request.status === query.status),
    cursor: scanned.length > limit ? (window.at(-1)?.id ?? null) : null,
  };
}

function archiveRequestPage(
  store: ApprovalArchiveStore | undefined,
  appId: string,
  query: ApprovalListQuery,
  cursor: { proposedAt: string; id: string } | undefined,
  limit: number,
) {
  if (!store || !archiveCanMatch(query.status)) return Promise.resolve([]);
  return store.list({
    appId,
    limit,
    ...(query.status ? { status: query.status } : {}),
    ...(query.target_kind ? { targetType: query.target_kind } : {}),
    ...(query.environmentId ? { environmentId: query.environmentId } : {}),
    ...(cursor ? { after: cursor } : {}),
  });
}

async function resolveCursor(
  deps: ApprovalHandlerDeps,
  appId: string,
  requestId: string,
  includeArchive: boolean,
): Promise<{ id: string; proposedAt: string } | null> {
  const online = await deps.repo.approvals.getRequest(appScope(appId), requestId);
  if (online) return { id: online.id, proposedAt: online.proposedAt };
  if (!includeArchive) return null;
  const event = await deps.archiveStore?.get(appId, requestId, APPROVAL_ARCHIVE_VERSION);
  if (!event) return null;
  const archived = await archivedApprovalRequest(event, appId);
  return { id: archived.id, proposedAt: archived.proposedAt };
}

function archiveCanMatch(status: string | undefined): boolean {
  return (
    status === undefined || status === "applied" || status === "declined" || status === "stale"
  );
}

function compareRequests(left: ApprovalRequest, right: ApprovalRequest): number {
  if (left.proposedAt !== right.proposedAt) return left.proposedAt > right.proposedAt ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

function statusFilter(status: string | undefined): readonly string[] | undefined {
  if (!status) return undefined;
  // Only a stored `pending` row can render as `pending`; a `stale` render comes
  // from either a stored `pending` row whose target moved or an already
  // materialized `stale` row.
  if (status === "pending") return ["pending"];
  if (status === "stale") return ["pending", "stale"];
  return [status];
}

function queryInput(input: unknown) {
  const query = (input as { query?: unknown }).query;
  return query && typeof query === "object" && !Array.isArray(query)
    ? (query as ApprovalListQuery)
    : {};
}

function approvalNotFound(requestId: string) {
  return renderError(
    {
      code: "APPROVAL_REQUEST_NOT_FOUND",
      message: "Approval Request not found",
      details: {},
    },
    { requestId },
  );
}
