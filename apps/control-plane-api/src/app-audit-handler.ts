import {
  AppAuditListQuerySchema,
  AppAuditListResponseSchema,
  ErrorResponseSchema,
  getRoute,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import {
  delegatedIdentityFrom,
  delegatedRequest,
  type HandlerArgs,
  renderError,
} from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz";
import { appNotFound } from "./app-environment-model";

export async function handleAppAuditRead(
  deps: { repo: Repository; binding: Fetcher | undefined },
  { input, principal, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const route = getRoute("app_audit_list");
  if (!route) throw new Error("App audit route is not registered");
  const { params, query } = input as { params: { appId: string }; query: unknown };
  const denied = await requireAppAdmin(deps, params.appId, principal, requestId);
  if (denied) return denied;
  const app = await deps.repo.identity.getApp(params.appId);
  if (!app) return appNotFound(requestId);
  if (!deps.binding) return unavailable(requestId);

  let response: Response;
  try {
    const { cursor, ...queryWithoutCursor } = AppAuditListQuerySchema.parse(query);
    response = await deps.binding.fetch(
      delegatedRequest(route, delegatedIdentityFrom(route, principal, params), {
        params,
        query: { ...queryWithoutCursor, ...(cursor === null ? {} : { cursor }) },
        requestId,
      }),
    );
  } catch {
    return unavailable(requestId);
  }
  try {
    if (!response.ok) {
      return renderError(ErrorResponseSchema.parse(await response.json()), { requestId });
    }
    const result = AppAuditListResponseSchema.parse(await response.json());
    if (
      result.items.some(
        (event) => event.appId !== app.id || event.organizationId !== app.organizationId,
      )
    ) {
      throw new Error("App audit scope mismatch");
    }
    return Response.json(result);
  } catch {
    return renderError(
      { code: "INTERNAL_SERVER_ERROR", message: "App audit read failed", details: {} },
      { requestId },
    );
  }
}

function unavailable(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "App audit is unavailable",
      details: { retryAfterMs: 30_000 },
    },
    { requestId },
  );
}
