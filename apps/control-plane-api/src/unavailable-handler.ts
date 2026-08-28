import {
  type UnavailableControlPlaneOperationId,
  unavailableControlPlaneOperationIds,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { HandlerArgs, Registrar, RouteHandler } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { requireAppWrite } from "./app-authz";
import { pathParam } from "./handler-input";
import { ORG_OWNER_ROLES, requireOrgRole } from "./org-authz";
import { controlPlaneRoute } from "./routes";

interface UnavailableHandlerDeps {
  repo: Repository;
}

type PrivacyRequest = NonNullable<
  Awaited<ReturnType<Repository["privacy"]["getPrivacyRequestById"]>>
>;

/**
 * Preserve the shared HTTP/MCP error contract for routes whose backing workflow
 * is intentionally not available in this slice.
 */
function unavailableControlPlaneOperation(
  deps: UnavailableHandlerDeps,
  operationId: UnavailableControlPlaneOperationId,
): RouteHandler<unknown> {
  return async (args) => {
    const authorizationError = await authorizeUnavailableOperation(deps, operationId, args);
    if (authorizationError) return authorizationError;
    return unavailableResponse(args.requestId);
  };
}

async function authorizeUnavailableOperation(
  deps: UnavailableHandlerDeps,
  operationId: UnavailableControlPlaneOperationId,
  args: HandlerArgs<unknown>,
): Promise<Response | null> {
  switch (operationId) {
    case "organizations_delete":
    case "organization_privacy_export":
      return requireOrgRole(
        deps,
        pathParam(args.input, "orgId"),
        args.principal,
        ORG_OWNER_ROLES,
        args.requestId,
      );
    case "app_privacy_export":
    case "entity_privacy_export":
    case "entity_privacy_delete":
      return requireAppWrite(deps, pathParam(args.input, "appId"), args.principal, args.requestId);
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

  const orgAuthorization = await requireScopedOrgOwner(deps, args, privacyRequest);
  if (orgAuthorization === null) return null;

  if (!privacyRequest.appId) {
    return orgAuthorization ?? resourceScopeForbidden("organization", args.requestId);
  }

  const appAuthorization = await requireScopedAppAdmin(deps, args, privacyRequest.appId);
  if (appAuthorization === null) return null;
  return (
    orgAuthorization ??
    appAuthorization ??
    resourceScopeForbidden("organization or app", args.requestId)
  );
}

async function requireScopedOrgOwner(
  deps: UnavailableHandlerDeps,
  args: HandlerArgs<unknown>,
  privacyRequest: PrivacyRequest,
): Promise<Response | null | undefined> {
  if (args.principal.orgId !== privacyRequest.orgId) return undefined;
  return requireOrgRole(
    deps,
    privacyRequest.orgId,
    args.principal,
    ORG_OWNER_ROLES,
    args.requestId,
  );
}

async function requireScopedAppAdmin(
  deps: UnavailableHandlerDeps,
  args: HandlerArgs<unknown>,
  appId: string,
): Promise<Response | null | undefined> {
  if (args.principal.appId !== appId) return undefined;
  return requireAppWrite(deps, appId, args.principal, args.requestId);
}

function resourceScopeForbidden(resource: string, requestId: string): Response {
  return renderError(
    { code: "FORBIDDEN", message: `credential is not scoped to this ${resource}`, details: {} },
    { requestId },
  );
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

export function mountUnavailableControlPlaneRoutes(
  app: Hono,
  registrar: Registrar,
  repo: Repository,
): void {
  for (const operationId of unavailableControlPlaneOperationIds) {
    if (operationId === "entity_privacy_export" || operationId === "entity_privacy_delete") {
      continue;
    }
    registrar.mount(
      app,
      controlPlaneRoute(operationId),
      unavailableControlPlaneOperation({ repo }, operationId),
    );
  }
}
