import { deriveSlug } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppDelete, requireAppWrite } from "./app-authz";
import { deleteEnvironmentCredentials } from "./app-environment-credentials";
import {
  ALLOW_POLICY,
  type AppEnvironmentDeps,
  type AppRow,
  appNotFound,
  appResponse,
  CONFIRM_POLICY,
  createEnvironmentRecord,
  deleteAppBlockedByChildren,
  type EnvironmentRow,
  environmentResponse,
  firstRunningExperiment,
  nowIso,
  organizationNotFound,
  provisionEnvironmentClientKeys,
  unusableAppKey,
} from "./app-environment-model";
import { randomHex } from "./credential-cache";
import { objectBody, pathParam } from "./handler-input";
import { ORG_ADMIN_ROLES, ORG_MEMBER_ROLES, requireOrgRole } from "./org-authz";

export function makeAppHandlers(deps: AppEnvironmentDeps) {
  return {
    async listApps({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const orgId = pathParam(input, "orgId");
      const forbidden = await requireOrgRole(deps, orgId, principal, ORG_MEMBER_ROLES, requestId);
      if (forbidden) return forbidden;

      const org = await deps.repo.identity.getOrg(orgId);
      if (!org) return organizationNotFound(requestId);

      const rows = await deps.repo.identity.listAppsForOrg(orgId);
      return Response.json({ items: rows.map(appResponse) });
    },

    async createApp({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const orgId = pathParam(input, "orgId");
      const forbidden = await requireOrgRole(deps, orgId, principal, ORG_ADMIN_ROLES, requestId);
      if (forbidden) return forbidden;

      const org = await deps.repo.identity.getOrg(orgId);
      if (!org) return organizationNotFound(requestId);

      const body = objectBody(input);
      const name = body.name as string;
      // An explicit `key` is already schema-validated by the guard; derivation is
      // the fallback and can legitimately fail, so it fails loud rather than
      // inventing a handle the caller never chose. Same contract as an Org slug.
      const key = typeof body.key === "string" ? body.key : deriveSlug(name);
      if (!key) return unusableAppKey(name, requestId);

      const now = nowIso(deps);
      const app = await deps.repo.identity.createApp({
        id: `app_${randomHex(12)}`,
        organizationId: orgId,
        name,
        key,
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
      const clientKeys = await provisionEnvironmentClientKeys(deps, app.id, app.organizationId, [
        dev,
        prod,
      ]);

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

      const writeError = await requireAppWrite(deps, appId, principal, requestId);
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

      const deleteError = await requireAppDelete(deps, appId, principal, requestId);
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

async function deleteAppRows(
  deps: AppEnvironmentDeps,
  appId: string,
  environments: readonly EnvironmentRow[],
): Promise<void> {
  const scope = appScope(appId);
  for (const env of environments) {
    await deleteEnvironmentCredentials(deps, appId, env.id);
    if ((await deps.repo.identity.deleteEnvironment(scope, env.id)) !== 1) {
      throw new Error("environment delete did not reach D1");
    }
  }
  await deps.repo.identity.deleteAppMemberships(scope);
  if ((await deps.repo.identity.deleteApp(appId)) !== 1) {
    throw new Error("app delete did not reach D1");
  }
}
