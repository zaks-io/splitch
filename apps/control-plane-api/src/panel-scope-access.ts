import { type UserRole, UserRoleSchema } from "@splitch/contracts";
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

export type PanelAppScopeAccess =
  | { ok: true; app: AppRow; role: UserRole; orgRole: UserRole }
  | { ok: false; response: Response };

/**
 * The App-scoped half of the same recheck, for Panel operations that name no
 * Environment (App Settings). Live Organization AND App membership, read fresh
 * for this exact call, never from the delegation claim. Both live roles are
 * handed back so the caller renders the viewer's real capabilities instead of
 * a stale session claim.
 *
 * All three reads issue CONCURRENTLY. Loading the App first only to learn which
 * Org to check membership in put a serial D1 round trip in front of every Panel
 * App call, and the round trip is what these endpoints pay for;
 * `getOrgMembershipForApp` reaches the same Org from the App id. The checks
 * themselves are unchanged: every one still has to pass, and a missing App is
 * still answered before either membership is consulted.
 */
export async function panelAppScopeAccess(
  repo: Repository,
  scope: { actorId: string; appId: string },
  requestId: string,
): Promise<PanelAppScopeAccess> {
  const [app, orgMembership, appMembership] = await Promise.all([
    repo.identity.getApp(scope.appId),
    repo.identity.getOrgMembershipForApp(scope.appId, scope.actorId),
    repo.identity.getAppMembership(appScope(scope.appId), scope.actorId),
  ]);
  if (!app) return { ok: false, response: notFound("App not found", requestId) };
  if (!orgMembership || !appMembership) return { ok: false, response: forbidden(requestId) };
  return {
    ok: true,
    app,
    role: UserRoleSchema.parse(appMembership.role),
    orgRole: UserRoleSchema.parse(orgMembership.role),
  };
}

/**
 * Rechecks live Organization AND App membership plus Environment-belongs-to-App
 * for this exact call. D1 has no RLS (ADR-0018), so this is the authorization
 * boundary for every Panel read scoped to one Environment; it is never cached
 * across calls and never trusts the scope carried in the delegation claim.
 *
 * The rows it already had to read to authorize are handed back, so callers do
 * not re-read them under a scope this function has not checked.
 *
 * All four reads issue CONCURRENTLY, for the reason given on
 * `panelAppScopeAccess`. Concurrency does not widen the boundary: every check
 * below still has to pass, and reading a membership for an App that turns out
 * not to exist cannot grant anything, because the missing App is answered
 * first.
 */
export async function panelScopeAccess(
  repo: Repository,
  scope: PanelScope,
  requestId: string,
): Promise<PanelScopeAccess> {
  const [app, orgMembership, appMembership, environment] = await Promise.all([
    repo.identity.getApp(scope.appId),
    repo.identity.getOrgMembershipForApp(scope.appId, scope.actorId),
    repo.identity.getAppMembership(appScope(scope.appId), scope.actorId),
    repo.identity.getEnvironment(appScope(scope.appId), scope.environmentId),
  ]);
  if (!app) return { ok: false, response: notFound("App not found", requestId) };
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
