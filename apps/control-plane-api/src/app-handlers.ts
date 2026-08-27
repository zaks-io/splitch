import { boundListRead, LIST_READ_LIMIT } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppDelete, requireAppWrite } from "./app-authz";
import { createAppRequest } from "./app-create-handler";
import { forceDeleteApp } from "./app-delete-force";
import {
  deleteAppRowsWithHoldoverSaga,
  renderAppDeleteCleanupError,
  resumeHoldoverFinalizeAfterAppGone,
} from "./app-delete-holdover";
import { collectAppDeleteBlockers } from "./app-delete-tree";
import {
  type AppEnvironmentDeps,
  type AppRow,
  appNotFound,
  appResponse,
  appSlugConflict,
  type EnvironmentRow,
  firstRunningExperiment,
  nowIso,
  organizationNotFound,
  resourceNotEmptyFromBlockers,
} from "./app-environment-model";
import { objectBody, pathParam, queryFlags } from "./handler-input";
import { ORG_MEMBER_ROLES, requireOrgRole } from "./org-authz";

export function makeAppHandlers(deps: AppEnvironmentDeps) {
  return {
    async listApps({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const orgId = pathParam(input, "orgId");
      const forbidden = await requireOrgRole(deps, orgId, principal, ORG_MEMBER_ROLES, requestId);
      if (forbidden) return forbidden;

      const org = await deps.repo.identity.getOrg(orgId);
      if (!org) return organizationNotFound(requestId);

      const scanned = await deps.repo.identity.listAppsForOrg(orgId, {
        limit: LIST_READ_LIMIT + 1,
      });
      return Response.json(boundListRead(scanned.map(appResponse)));
    },

    async createApp(args: HandlerArgs<unknown>): Promise<Response> {
      return createAppRequest(deps, args);
    },

    async getApp({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const app = await deps.repo.identity.getApp(pathParam(input, "appId"));
      if (!app) return appNotFound(requestId);
      return Response.json(appResponse(app));
    },

    async updateApp({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const writeError = await requireAppWrite(deps, appId, principal, requestId);
      if (writeError) return writeError;

      const body = objectBody(input);
      const key = body.key as string | undefined;
      const conflict = await slugConflictResponse(deps, app, key, requestId);
      if (conflict) return conflict;

      const updated = await deps.repo.identity.updateApp(appId, {
        ...appPatch(body, key),
        updatedAt: nowIso(deps),
      });
      if (!updated) return appNotFound(requestId);
      return Response.json(appResponse(updated));
    },

    async deleteApp({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      return deleteAppRequest(deps, input, principal, requestId);
    },
  };
}

async function deleteAppRequest(
  deps: AppEnvironmentDeps,
  input: unknown,
  principal: HandlerArgs<unknown>["principal"],
  requestId: string,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const app = await deps.repo.identity.getApp(appId);
  if (!app) {
    return resumeOrRethrowAppGone(deps, appId, principal, requestId);
  }
  const deleteError = await requireAppDelete(deps, appId, principal, requestId);
  if (deleteError) return deleteError;
  const mode = queryFlags(input);
  try {
    return await deleteAppAfterAuth(deps, app, principal, requestId, mode);
  } catch (cause) {
    const cleanupError = renderAppDeleteCleanupError(cause, requestId);
    if (cleanupError) return cleanupError;
    throw cause;
  }
}

async function resumeOrRethrowAppGone(
  deps: AppEnvironmentDeps,
  appId: string,
  principal: HandlerArgs<unknown>["principal"],
  requestId: string,
): Promise<Response> {
  try {
    return await resumeHoldoverFinalizeAfterAppGone(deps, appId, principal, requestId);
  } catch (cause) {
    const cleanupError = renderAppDeleteCleanupError(cause, requestId);
    if (cleanupError) return cleanupError;
    throw cause;
  }
}

/**
 * Only the fields the caller actually sent. An absent field is left alone rather
 * than written back as a default, so a partial update cannot quietly blank a
 * name or a description the caller never mentioned.
 */
function appPatch(
  body: Record<string, unknown>,
  key: string | undefined,
): { name?: string; key?: string; description?: string } {
  return {
    ...(body.name !== undefined ? { name: body.name as string } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(body.description !== undefined ? { description: body.description as string } : {}),
  };
}

/**
 * The slug is unique within the Organization and every URL for the App is built
 * from it, so a collision is refused with the losing slug named rather than
 * silently deduped into a second handle. `apps_org_key_unique` still backs this
 * up in D1; the pre-check exists to turn that constraint into a typed refusal.
 */
async function slugConflictResponse(
  deps: AppEnvironmentDeps,
  app: AppRow,
  key: string | undefined,
  requestId: string,
): Promise<Response | null> {
  if (key === undefined || key === app.key) return null;
  const siblings = await deps.repo.identity.listAppsForOrg(app.organizationId);
  const taken = siblings.some((sibling) => sibling.key === key && sibling.id !== app.id);
  return taken ? appSlugConflict(key, requestId) : null;
}

async function deleteAppAfterAuth(
  deps: AppEnvironmentDeps,
  app: AppRow,
  principal: HandlerArgs<unknown>["principal"],
  requestId: string,
  mode: { dryRun: boolean; force: boolean },
): Promise<Response> {
  const environments = await deps.repo.identity.listEnvironments(appScope(app.id));
  const running = await firstRunningExperiment(deps, app.id, environments, "DELETE_APP", requestId);
  if (running) return running;

  const blockers = await collectAppDeleteBlockers(deps, app, environments);

  if (mode.dryRun) {
    return Response.json({ deleted: false, dryRun: true, blockers });
  }

  if (mode.force) {
    const deleteAuthorizedAppRows = (
      cleanupDeps: AppEnvironmentDeps,
      appId: string,
      liveEnvironments: readonly EnvironmentRow[],
    ) =>
      deleteAppRowsWithHoldoverSaga(
        cleanupDeps,
        appId,
        app.organizationId,
        liveEnvironments,
        principal.id,
        requestId,
      );
    const result = await forceDeleteApp(
      deps,
      app,
      environments,
      principal,
      requestId,
      deleteAuthorizedAppRows,
      blockers,
    );
    return Response.json(result.response);
  }

  if (blockers.length > 0) {
    return resourceNotEmptyFromBlockers(app.id, "app", blockers, "DELETE_APP", requestId);
  }

  await deleteAppRowsWithHoldoverSaga(
    deps,
    app.id,
    app.organizationId,
    environments,
    principal.id,
    requestId,
  );
  return Response.json({ deleted: true });
}
