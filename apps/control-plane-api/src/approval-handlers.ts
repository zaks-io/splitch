import type { ApprovalRequest } from "@splitch/contracts";
import { type ApprovalCommit, appScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { requireAppMember } from "./app-authz";
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
      return row
        ? Response.json(await approvalRequestProjection(deps.repo, row))
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
  query: {
    status?: string;
    target_kind?: string;
    limit?: number;
    cursor?: string | null;
  },
  requestId: string,
): Promise<Response> {
  const limit = query.limit ?? 50;
  const scope = appScope(appId);
  const after = query.cursor
    ? await deps.repo.approvals.getRequest(scope, query.cursor)
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
  };
  const rows = await deps.repo.approvals.listRequestPage(scope, {
    ...filters,
    limit: limit + 1,
    ...(after ? { after: { proposedAt: after.proposedAt, id: after.id } } : {}),
  });
  const page = rows.slice(0, limit);
  const items = (
    await Promise.all(page.map((row) => approvalRequestProjection(deps.repo, row)))
  ).filter((request) => !query.status || request.status === query.status);
  return Response.json({
    items,
    cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    limit,
    // A `pending`/`stale` filter is resolved after projection, so no SQL count
    // can state it honestly. `null` is the contract's "not computed".
    total: effectiveOnly ? null : await deps.repo.approvals.countRequests(scope, filters),
  });
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
    ? (query as {
        status?: string;
        target_kind?: string;
        limit?: number;
        cursor?: string | null;
      })
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
