import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppDelete, requireAppWrite } from "./app-authz.js";
import {
  deleteEnvironmentCredentialRows,
  revokeEnvironmentCredentialCaches,
} from "./app-environment-credentials.js";
import {
  ALLOW_POLICY,
  CONFIRM_POLICY,
  type AppEnvironmentDeps,
  type AppRow,
  type EnvironmentRow,
  appNotFound,
  appResponse,
  createEnvironmentRecord,
  deleteAppBlockedByChildren,
  environmentResponse,
  firstRunningExperiment,
  nowIso,
  organizationIdMismatch,
  organizationNotFound,
  provisionEnvironmentClientKeys,
} from "./app-environment-model.js";
import { randomHex } from "./credential-cache.js";
import { objectBody, pathParam } from "./handler-input.js";
import { ORG_ADMIN_ROLES, ORG_MEMBER_ROLES, requireOrgRole } from "./org-authz.js";

export function makeAppHandlers(deps: AppEnvironmentDeps) {
  return {
    async listApps({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const orgId = pathParam(input, "orgId");
      const forbidden = await requireOrgRole(
        deps,
        orgId,
        principal.id,
        ORG_MEMBER_ROLES,
        requestId,
      );
      if (forbidden) return forbidden;

      const org = await deps.repo.identity.getOrg(orgId);
      if (!org) return organizationNotFound(requestId);

      const rows = await deps.repo.identity.listAppsForOrg(orgId);
      return Response.json({ items: rows.map(appResponse) });
    },

    async createApp({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const orgId = pathParam(input, "orgId");
      const forbidden = await requireOrgRole(deps, orgId, principal.id, ORG_ADMIN_ROLES, requestId);
      if (forbidden) return forbidden;

      const org = await deps.repo.identity.getOrg(orgId);
      if (!org) return organizationNotFound(requestId);

      const body = objectBody(input);
      if (body.organizationId !== orgId) return organizationIdMismatch(requestId);

      const now = nowIso(deps);
      const app = await deps.repo.identity.createApp({
        id: `app_${randomHex(12)}`,
        organizationId: orgId,
        name: body.name as string,
        key: body.key as string,
        ...(body.description ? { description: body.description as string } : {}),
        createdAt: now,
        updatedAt: now,
        createdBy: principal.id,
      });
      const scope = appScope(app.id);
      await deps.repo.identity.createAppMembership({
        appId: app.id,
        userId: principal.id,
        role: "owner",
        createdAt: now,
      });

      const dev = await createEnvironmentRecord(deps, scope, app.id, {
        key: "dev",
        name: "Dev",
        policy: ALLOW_POLICY,
        actorId: principal.id,
      });
      const prod = await createEnvironmentRecord(deps, scope, app.id, {
        key: "prod",
        name: "Prod",
        policy: CONFIRM_POLICY,
        actorId: principal.id,
      });
      const clientKeys = await provisionEnvironmentClientKeys(deps, app.id, [dev, prod]);

      return Response.json({
        app: appResponse(app),
        environments: [environmentResponse(dev), environmentResponse(prod)],
        clientKeys,
      });
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

      const writeError = await requireAppWrite(deps, appId, principal.id, requestId);
      if (writeError) return writeError;

      const body = objectBody(input);
      const updated = await deps.repo.identity.updateApp(appId, {
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.description !== undefined ? { description: body.description as string } : {}),
        updatedAt: nowIso(deps),
      });
      if (!updated) return appNotFound(requestId);
      return Response.json(appResponse(updated));
    },

    async deleteApp({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const deleteError = await requireAppDelete(deps, appId, principal.id, requestId);
      if (deleteError) return deleteError;

      return deleteAppAfterAuth(deps, app, requestId);
    },
  };
}

async function deleteAppAfterAuth(
  deps: AppEnvironmentDeps,
  app: AppRow,
  requestId: string,
): Promise<Response> {
  const environments = await deps.repo.identity.listEnvironments(appScope(app.id));
  const blocker = await appDeleteBlocker(deps, app, environments, requestId);
  if (blocker) return blocker;

  await revokeAppCredentialCaches(deps, app.id, environments);
  await deleteAppRows(deps, app.id, environments);
  return Response.json({ deleted: true });
}

async function appDeleteBlocker(
  deps: AppEnvironmentDeps,
  app: AppRow,
  environments: readonly EnvironmentRow[],
  requestId: string,
): Promise<Response | null> {
  return (
    (await firstRunningExperiment(deps, app.id, environments, "DELETE_APP", requestId)) ??
    (await deleteAppBlockedByChildren(deps, app, environments, requestId))
  );
}

async function revokeAppCredentialCaches(
  deps: AppEnvironmentDeps,
  appId: string,
  environments: readonly EnvironmentRow[],
): Promise<void> {
  for (const env of environments) {
    await revokeEnvironmentCredentialCaches(deps, appId, env.id);
  }
}

async function deleteAppRows(
  deps: AppEnvironmentDeps,
  appId: string,
  environments: readonly EnvironmentRow[],
): Promise<void> {
  const scope = appScope(appId);
  for (const env of environments) {
    await deleteEnvironmentCredentialRows(deps, appId, env.id);
    await deps.repo.identity.deleteEnvironment(scope, env.id);
  }
  await deps.repo.identity.deleteAppMemberships(scope);
  await deps.repo.identity.deleteApp(appId);
}
