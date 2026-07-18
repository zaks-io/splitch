import type { Repository } from "@splitch/db";
import type { HandlerArgs, RouteHandler } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { requireAppWrite } from "./app-authz";
import { pathParam } from "./handler-input";
import { ORG_OWNER_ROLES, requireOrgRole } from "./org-authz";

type UnavailableOperationId =
  | "organizations_delete"
  | "current_user_privacy_export"
  | "current_user_delete"
  | "organization_privacy_export"
  | "app_privacy_export"
  | "entity_privacy_export"
  | "entity_privacy_delete"
  | "privacy_requests_get";

interface UnavailableHandlerDeps {
  repo: Repository;
}

/**
 * Preserve the shared HTTP/MCP error contract for routes whose backing workflow
 * is intentionally not available in this slice.
 */
export function unavailableControlPlaneOperation(
  deps: UnavailableHandlerDeps,
  operationId: UnavailableOperationId,
): RouteHandler<unknown> {
  return async (args) => {
    const authorizationError = await authorizeUnavailableOperation(deps, operationId, args);
    if (authorizationError) return authorizationError;
    return unavailableResponse(args.requestId);
  };
}

async function authorizeUnavailableOperation(
  deps: UnavailableHandlerDeps,
  operationId: UnavailableOperationId,
  args: HandlerArgs<unknown>,
): Promise<Response | null> {
  switch (operationId) {
    case "organizations_delete":
    case "organization_privacy_export":
      return requireOrgRole(
        deps,
        pathParam(args.input, "orgId"),
        args.principal.id,
        ORG_OWNER_ROLES,
        args.requestId,
      );
    case "app_privacy_export":
    case "entity_privacy_export":
    case "entity_privacy_delete":
      return requireAppWrite(
        deps,
        pathParam(args.input, "appId"),
        args.principal.id,
        args.requestId,
      );
    case "privacy_requests_get":
      return authorizePrivacyRequestStatus(deps, args);
    case "current_user_privacy_export":
    case "current_user_delete":
      return null;
  }
}

async function authorizePrivacyRequestStatus(
  deps: UnavailableHandlerDeps,
  args: HandlerArgs<unknown>,
): Promise<Response | null> {
  const privacyRequest = await deps.repo.privacy.getPrivacyRequestById(
    pathParam(args.input, "requestId"),
  );
  if (!privacyRequest) {
    return renderError(
      { code: "PRIVACY_JOB_NOT_FOUND", message: "privacy request not found", details: {} },
      { requestId: args.requestId },
    );
  }
  if (privacyRequest.requestedBy === args.principal.id) return null;

  const orgAuthorization = await requireOrgRole(
    deps,
    privacyRequest.orgId,
    args.principal.id,
    ORG_OWNER_ROLES,
    args.requestId,
  );
  if (!orgAuthorization) return null;

  if (privacyRequest.appId) {
    const appAuthorization = await requireAppWrite(
      deps,
      privacyRequest.appId,
      args.principal.id,
      args.requestId,
    );
    if (!appAuthorization) return null;
  }

  return orgAuthorization;
}

function unavailableResponse(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "operation is not available yet",
      details: { retryAfterMs: 1000 },
    },
    { requestId },
  );
}
