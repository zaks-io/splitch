import { appScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import type { AppRow, EnvironmentRow } from "./app-environment-model";

export interface PanelScope {
  actorId: string;
  appId: string;
  environmentId: string;
}

export type PanelScopeAccess =
  | { ok: true; app: AppRow; environment: EnvironmentRow }
  | { ok: false; response: Response };

/**
 * Rechecks live Organization AND App membership plus Environment-belongs-to-App
 * for this exact call. D1 has no RLS (ADR-0018), so this is the authorization
 * boundary for every Panel read scoped to one Environment; it is never cached
 * across calls and never trusts the scope carried in the delegation claim.
 *
 * The rows it already had to read to authorize are handed back, so callers do
 * not re-read them under a scope this function has not checked.
 */
export async function panelScopeAccess(
  repo: Repository,
  scope: PanelScope,
  requestId: string,
): Promise<PanelScopeAccess> {
  const app = await repo.identity.getApp(scope.appId);
  if (!app) return { ok: false, response: notFound("App not found", requestId) };
  const [orgMembership, appMembership, environment] = await Promise.all([
    repo.identity.getOrgMembership(app.organizationId, scope.actorId),
    repo.identity.getAppMembership(appScope(scope.appId), scope.actorId),
    repo.identity.getEnvironment(appScope(scope.appId), scope.environmentId),
  ]);
  if (!orgMembership || !appMembership) return { ok: false, response: forbidden(requestId) };
  if (!environment) {
    return { ok: false, response: notFound("Environment not found", requestId) };
  }
  return { ok: true, app, environment };
}

export async function panelScopeAccessError(
  repo: Repository,
  scope: PanelScope,
  requestId: string,
): Promise<Response | null> {
  const access = await panelScopeAccess(repo, scope, requestId);
  return access.ok ? null : access.response;
}

function forbidden(requestId: string): Response {
  return renderError(
    { code: "FORBIDDEN", message: "live App membership is required", details: {} },
    { requestId },
  );
}

function notFound(message: string, requestId: string): Response {
  return renderError({ code: "APP_NOT_FOUND", message, details: {} }, { requestId });
}
