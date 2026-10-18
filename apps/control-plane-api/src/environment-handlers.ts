import { boundListRead, type EnvironmentPolicy, LIST_READ_LIMIT } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { requireAppDelete, requireAppWrite } from "./app-authz";
import { deleteEnvironmentCredentials } from "./app-environment-credentials";
import {
  type AppEnvironmentDeps,
  appNotFound,
  deleteEnvironmentBlockedByChildren,
  environmentResponse,
  lastEnvironmentRequired,
  nowIso,
  runningExperimentError,
} from "./app-environment-model";
import { createPermanentEnvironment } from "./environment-create";
import { EnvironmentExposureStatusCleanupError } from "./environment-exposure-status-cleanup";
import { objectBody, pathParam } from "./handler-input";
import { resolvedEnvironment } from "./resolved-environment";
import { createTemporaryEnvironment } from "./temporary-environment-create";
import { environmentKindUnsupported } from "./temporary-environment-errors";
import { makeEnvironmentSyncHandler } from "./temporary-environment-sync";
import { teardownTemporaryEnvironment } from "./temporary-environment-teardown";

export function makeEnvironmentHandlers(deps: AppEnvironmentDeps) {
  return {
    syncEnvironment: makeEnvironmentSyncHandler(deps),
    async listEnvironments({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const scanned = await deps.repo.identity.listEnvironments(appScope(appId), {
        limit: LIST_READ_LIMIT + 1,
      });
      return Response.json(boundListRead(scanned.map(environmentResponse)));
    },

    async createEnvironment({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const writeError = await requireAppWrite(deps, appId, principal, requestId);
      if (writeError) return writeError;

      const body = objectBody(input);
      if (principal.personalAccessToken?.temporaryEnvironmentOnly && body.temporary === undefined)
        return renderError(
          {
            code: "FORBIDDEN",
            message: `personal access token needs write permission for app:${appId}; temporary_environments covers only Temporary Environments`,
            details: {},
          },
          { requestId },
        );
      if (body.temporary !== undefined)
        return createTemporaryEnvironment(deps, app, body, principal, requestId);
      return createPermanentEnvironment(deps, app, body, principal, requestId);
    },

    async getEnvironment({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const resolved = resolvedEnvironment(input, appId, environmentId);
      const environment =
        resolved === undefined
          ? await deps.repo.identity.getEnvironment(appScope(appId), environmentId)
          : resolved;
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

      const writeError = await requireAppWrite(deps, appId, principal, requestId);
      if (writeError) return writeError;

      const body = objectBody(input);
      const environment = await deps.repo.identity.getEnvironment(appScope(appId), environmentId);
      if (environment && environment.expiresAt !== null && body.policy !== undefined) {
        return environmentKindUnsupported(environment, "environments_update", requestId);
      }
      const updated = await deps.repo.identity.updateEnvironment(
        appScope(appId),
        environmentId,
        environmentPatch(body, nowIso(deps)),
      );
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

      const deleteError = await requireAppDelete(deps, appId, principal, requestId);
      if (deleteError) return deleteError;

      return deleteEnvironmentWithRecovery(
        deps,
        appId,
        app.organizationId,
        environmentId,
        principal.id,
        requestId,
      );
    },
  };
}

function exposureCleanupUnavailable(
  requestId: string,
  message = "Exposure status cleanup is unavailable",
): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message,
      details: { retryAfterMs: 30_000 },
    },
    { requestId },
  );
}

async function deleteEnvironmentAfterAuth(
  deps: AppEnvironmentDeps,
  appId: string,
  organizationId: string,
  environmentId: string,
  actorId: string,
  requestId: string,
): Promise<Response> {
  const scope = appScope(appId);
  const environments = await deps.repo.identity.listEnvironments(scope);
  const environment = environments.find((env) => env.id === environmentId);
  if (!environment) {
    const cleanup = deps.exposureStatusCleanup;
    if (!cleanup) throw new Error("environment delete requires Exposure status cleanup");
    await cleanup.delete({ appId, environmentId, actorId, orgId: organizationId, requestId });
    return Response.json({ deleted: true });
  }

  if (environment.expiresAt !== null) {
    await teardownTemporaryEnvironment(deps, {
      appId,
      environmentId,
      orgId: organizationId,
      actorId,
      requestId,
    });
    return Response.json({ deleted: true });
  }

  const blocker = await environmentDeleteBlocker(
    deps,
    appId,
    environmentId,
    environment,
    requestId,
  );
  if (blocker) return blocker;

  await deleteEnvironmentCredentials(deps, appId, environmentId);
  // Archived Experiments (and their Runs) are Experiment-level soft-deletes;
  // Environment teardown hard-purges them so the environment_id FK can clear.
  await deps.repo.experiments.purgeArchivedExperimentsInEnvironment(envScope(appId, environmentId));
  if ((await deps.repo.identity.deleteEnvironment(scope, environmentId)) !== 1) {
    throw new Error("environment delete did not reach D1");
  }
  const cleanup = deps.exposureStatusCleanup;
  if (!cleanup) throw new Error("environment delete requires Exposure status cleanup");
  await cleanup.delete({ appId, environmentId, actorId, orgId: organizationId, requestId });
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
  if (environments.filter((item) => item.expiresAt === null).length <= 1)
    return lastEnvironmentRequired(appId, requestId);

  return deleteEnvironmentBlockedByChildren(
    deps,
    appId,
    environmentId,
    "DELETE_ENVIRONMENT",
    requestId,
  );
}

async function deleteEnvironmentWithRecovery(
  deps: AppEnvironmentDeps,
  appId: string,
  organizationId: string,
  environmentId: string,
  actorId: string,
  requestId: string,
): Promise<Response> {
  try {
    return await deleteEnvironmentAfterAuth(
      deps,
      appId,
      organizationId,
      environmentId,
      actorId,
      requestId,
    );
  } catch (cause) {
    const environment = await deps.repo.identity.getEnvironment(appScope(appId), environmentId);
    if (!(cause instanceof EnvironmentExposureStatusCleanupError) && environment?.expiresAt == null)
      throw cause;
    if (environment?.expiresAt != null) {
      deps.onTeardownFault?.(cause, requestId);
      return exposureCleanupUnavailable(
        requestId,
        "Temporary Environment teardown is unavailable; retry delete",
      );
    }
    return exposureCleanupUnavailable(requestId);
  }
}

function environmentPatch(body: Record<string, unknown>, updatedAt: string) {
  return {
    ...(body.name !== undefined ? { name: body.name as string } : {}),
    ...(body.policy !== undefined
      ? { policy: JSON.stringify(body.policy as EnvironmentPolicy) }
      : {}),
    updatedAt,
  };
}
