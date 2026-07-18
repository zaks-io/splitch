import type { EnvironmentPolicy } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppDelete, requireAppWrite } from "./app-authz";
import { deleteEnvironmentCredentials } from "./app-environment-credentials";
import {
  ALLOW_POLICY,
  type AppEnvironmentDeps,
  appNotFound,
  createEnvironmentRecord,
  deleteEnvironmentBlockedByChildren,
  environmentResponse,
  lastEnvironmentRequired,
  nowIso,
  runningExperimentError,
} from "./app-environment-model";
import { provisionClientKey } from "./client-key-provisioning";
import { objectBody, pathParam } from "./handler-input";

export function makeEnvironmentHandlers(deps: AppEnvironmentDeps) {
  return {
    async listEnvironments({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const rows = await deps.repo.identity.listEnvironments(appScope(appId));
      return Response.json({ items: rows.map(environmentResponse) });
    },

    async createEnvironment({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const writeError = await requireAppWrite(deps, appId, principal.id, requestId);
      if (writeError) return writeError;

      const body = objectBody(input);
      const environment = await createEnvironmentRecord(deps, appScope(appId), appId, {
        key: body.key as string,
        name: (body.name as string | undefined) ?? (body.key as string),
        policy: (body.policy as EnvironmentPolicy | undefined) ?? ALLOW_POLICY,
        actorId: principal.id,
      });
      await provisionClientKey(deps, {
        appId,
        environmentId: environment.id,
        organizationId: app.organizationId,
        scope: envScope(appId, environment.id),
      });
      return Response.json(environmentResponse(environment));
    },

    async getEnvironment({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const environment = await deps.repo.identity.getEnvironment(appScope(appId), environmentId);
      if (!environment) return appNotFound(requestId);
      return Response.json(environmentResponse(environment));
    },

    async updateEnvironment({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const writeError = await requireAppWrite(deps, appId, principal.id, requestId);
      if (writeError) return writeError;

      const body = objectBody(input);
      const updated = await deps.repo.identity.updateEnvironment(appScope(appId), environmentId, {
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.policy !== undefined
          ? { policy: JSON.stringify(body.policy as EnvironmentPolicy) }
          : {}),
        updatedAt: nowIso(deps),
      });
      if (!updated) return appNotFound(requestId);
      return Response.json(environmentResponse(updated));
    },

    async deleteEnvironment({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const deleteError = await requireAppDelete(deps, appId, principal.id, requestId);
      if (deleteError) return deleteError;

      return deleteEnvironmentAfterAuth(deps, appId, environmentId, requestId);
    },
  };
}

async function deleteEnvironmentAfterAuth(
  deps: AppEnvironmentDeps,
  appId: string,
  environmentId: string,
  requestId: string,
): Promise<Response> {
  const scope = appScope(appId);
  const environments = await deps.repo.identity.listEnvironments(scope);
  const environment = environments.find((env) => env.id === environmentId);
  if (!environment) return appNotFound(requestId);

  const blocker = await environmentDeleteBlocker(
    deps,
    appId,
    environmentId,
    environment,
    requestId,
  );
  if (blocker) return blocker;

  await deleteEnvironmentCredentials(deps, appId, environmentId);
  if ((await deps.repo.identity.deleteEnvironment(scope, environmentId)) !== 1) {
    throw new Error("environment delete did not reach D1");
  }
  return Response.json({ deleted: true });
}

async function environmentDeleteBlocker(
  deps: AppEnvironmentDeps,
  appId: string,
  environmentId: string,
  environment: Awaited<
    ReturnType<AppEnvironmentDeps["repo"]["identity"]["listEnvironments"]>
  >[number],
  requestId: string,
): Promise<Response | null> {
  const running = await runningExperimentError(
    deps,
    appId,
    environment,
    "DELETE_ENVIRONMENT",
    requestId,
  );
  if (running) return running;

  const environments = await deps.repo.identity.listEnvironments(appScope(appId));
  if (environments.length <= 1) return lastEnvironmentRequired(appId, requestId);

  return deleteEnvironmentBlockedByChildren(
    deps,
    appId,
    environmentId,
    "DELETE_ENVIRONMENT",
    requestId,
  );
}
