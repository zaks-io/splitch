import type { EnvironmentPolicy } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppDelete, requireAppWrite } from "./app-authz.js";
import {
  ALLOW_POLICY,
  type AppEnvironmentDeps,
  appNotFound,
  createEnvironmentRecord,
  deleteEnvironmentChildren,
  environmentResponse,
  lastEnvironmentRequired,
  nowIso,
  runningExperimentError,
} from "./app-environment-model.js";
import { provisionClientKey } from "./client-key-provisioning.js";
import { objectBody, pathParam } from "./handler-input.js";

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
      const writeError = requireAppWrite(appId, principal.scopes, requestId);
      if (writeError) return writeError;

      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

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
      const writeError = requireAppWrite(appId, principal.scopes, requestId);
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
      const deleteError = requireAppDelete(appId, principal.scopes, requestId);
      if (deleteError) return deleteError;

      const scope = appScope(appId);
      const environments = await deps.repo.identity.listEnvironments(scope);
      const environment = environments.find((env) => env.id === environmentId);
      if (!environment) return appNotFound(requestId);

      const running = await runningExperimentError(
        deps,
        appId,
        environment,
        "DELETE_ENVIRONMENT",
        requestId,
      );
      if (running) return running;
      if (environments.length <= 1) return lastEnvironmentRequired(appId, requestId);

      await deleteEnvironmentChildren(deps, appId, environmentId);
      await deps.repo.identity.deleteEnvironment(scope, environmentId);
      return Response.json({ deleted: true });
    },
  };
}
