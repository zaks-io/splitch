import type { ApprovalRequest } from "@splitch/contracts";
import { type ApprovalCommit, appScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { requireAppMember } from "./app-authz";
import { approvalRequestProjection } from "./approval-model";
import { reviewApproval } from "./approval-service";
import type { ConfigStoreAccess } from "./config-store-do";
import { objectBody, pathParam } from "./handler-input";

interface ApprovalHandlerDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  nowIso?: () => string;
  applyOther?: (
    request: ApprovalRequest,
    commit: ApprovalCommit,
  ) => Promise<
    | { ok: true }
    | {
        ok: false;
        error: {
          code: import("@splitch/contracts").ErrorCode;
          details: Record<string, unknown>;
        };
      }
  >;
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
  const rows = await deps.repo.approvals.listRequests(appScope(appId));
  const projected = await Promise.all(rows.map((row) => approvalRequestProjection(deps.repo, row)));
  const filtered = projected.filter(
    (request) =>
      (!query.status || request.status === query.status) &&
      (!query.target_kind || request.target.type === query.target_kind),
  );
  const limit = query.limit ?? 50;
  const start = query.cursor ? filtered.findIndex((request) => request.id === query.cursor) + 1 : 0;
  if (query.cursor && start === 0) {
    return renderError(
      {
        code: "INVALID_PAGINATION",
        message: "pagination cursor is not valid for this Approval Request query",
        details: { field: "cursor", reason: "unknown cursor" },
      },
      { requestId },
    );
  }
  const items = filtered.slice(start, start + limit);
  return Response.json({
    items,
    cursor: start + limit < filtered.length ? (items.at(-1)?.id ?? null) : null,
    limit,
    total: filtered.length,
  });
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
