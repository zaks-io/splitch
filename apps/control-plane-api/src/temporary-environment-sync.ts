import { appScope } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { requireAppWrite } from "./app-authz";
import { type AppEnvironmentDeps, environmentResponse, nowIso } from "./app-environment-model";
import { objectBody, pathParam } from "./handler-input";
import {
  environmentExpiredError,
  environmentHasExpired,
  environmentKindUnsupported,
} from "./temporary-environment-errors";

const TEMPORARY_ENVIRONMENT_FLAG_LIMIT = 500;
export const TEMPORARY_ENVIRONMENT_LIVE_LIMIT = 50;

export function temporaryValidation(message: string, path: string[], requestId: string): Response {
  return renderError(
    { code: "VALIDATION_ERROR", message, details: { issues: [{ path, message }] } },
    { requestId },
  );
}

export async function loadSyncFlags(deps: AppEnvironmentDeps, appId: string, requestId: string) {
  const flags = await deps.repo.flags.flags.findMany(appScope(appId), undefined, {
    limit: TEMPORARY_ENVIRONMENT_FLAG_LIMIT + 1,
  });
  return flags.length > TEMPORARY_ENVIRONMENT_FLAG_LIMIT
    ? renderError(
        {
          code: "SYNC_LIMIT_EXCEEDED",
          message: "App exceeds the Temporary Environment Sync Flag limit",
          details: { appId, limit: TEMPORARY_ENVIRONMENT_FLAG_LIMIT, flags: flags.length },
        },
        { requestId },
      )
    : flags;
}

export async function resolveSyncSource(
  deps: AppEnvironmentDeps,
  appId: string,
  selector: string,
  requestId: string,
) {
  const matches = await deps.repo.identity.findEnvironmentSelectorCandidates(
    appScope(appId),
    selector,
  );
  if (matches.length > 1)
    return renderError(
      {
        code: "SELECTOR_AMBIGUOUS",
        message: "Environment selector matches more than one Environment",
        details: {
          candidates: matches.map(({ environmentId, environmentKey }) => ({
            environmentId,
            environmentKey,
          })),
          recommendedAction: "USE_CANONICAL_ID",
        },
      },
      { requestId },
    );
  return (
    matches[0]?.environment ??
    renderError(
      {
        code: "ENVIRONMENT_NOT_FOUND",
        message: "source Environment not found",
        details: {},
      },
      { requestId },
    )
  );
}

export async function copyEnvironmentFlags(
  deps: AppEnvironmentDeps,
  input: {
    appId: string;
    environmentId: string;
    fromEnvironmentId: string;
    actorId: string;
    authKind: HandlerArgs<unknown>["principal"]["kind"];
    requestId: string;
  },
  flags: Exclude<Awaited<ReturnType<typeof loadSyncFlags>>, Response>,
): Promise<Response | number> {
  const configStore = deps.configStore;
  if (!configStore) throw new Error("Temporary Environment Sync requires Config Store");
  let applied = 0;
  const failedFlagIds: string[] = [];
  // Match Environment provisioning's bounded fan-out. The writer serializes the target.
  for (let start = 0; start < flags.length; start += 6) {
    const batch = flags.slice(start, start + 6);
    const results = await Promise.allSettled(
      batch.map(async (flag) => {
        if (!flag.defaultVariantId) throw new Error(`Flag ${flag.id} has no Default Variant`);
        const result = await configStore
          .writerFor(input.appId, input.environmentId)
          .syncFlagConfig({
            appId: input.appId,
            environmentId: input.environmentId,
            flagId: flag.id,
            fromEnvironmentId: input.fromEnvironmentId,
            initialConfig: { defaultVariantId: flag.defaultVariantId },
            actor: { ref: input.actorId, via: input.authKind },
          });
        if (!result.ok) throw new Error(`Sync refused: ${result.reason}`);
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") applied += 1;
      else {
        const flag = batch[index];
        if (!flag) throw new Error("Sync batch result has no matching Flag");
        failedFlagIds.push(flag.id);
      }
    });
  }
  if (failedFlagIds.length > 0)
    return renderError(
      {
        code: "ENVIRONMENT_SYNC_INCOMPLETE",
        message: "Some Flag Configurations were not synced; retry Sync",
        details: {
          environmentId: input.environmentId,
          fromEnvironmentId: input.fromEnvironmentId,
          applied,
          failed: failedFlagIds.length,
          failedFlagIds: failedFlagIds.slice(0, 50),
          retryAfterMs: 1000,
        },
      },
      { requestId: input.requestId },
    );
  return applied;
}

export function makeEnvironmentSyncHandler(deps: AppEnvironmentDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const appId = pathParam(input, "appId");
    const environmentId = pathParam(input, "environmentId");
    const denied = await requireAppWrite(deps, appId, principal, requestId);
    if (denied) return denied;
    const environments = await resolveSyncEnvironments(
      deps,
      appId,
      environmentId,
      objectBody(input).fromEnvironmentId as string,
      requestId,
    );
    if (environments instanceof Response) return environments;
    const { target, source } = environments;
    const flags = await loadSyncFlags(deps, appId, requestId);
    if (flags instanceof Response) return flags;
    const syncedFlags = await copyEnvironmentFlags(
      deps,
      {
        appId,
        environmentId,
        fromEnvironmentId: source.id,
        actorId: principal.id,
        authKind: principal.kind,
        requestId,
      },
      flags,
    );
    if (syncedFlags instanceof Response) return syncedFlags;
    const updated = await deps.repo.identity.updateTemporaryEnvironmentSync(
      appScope(appId),
      environmentId,
      source.id,
      nowIso(deps),
    );
    if (!updated) return renderError(environmentExpiredError(target), { requestId });
    return Response.json({ ...environmentResponse(updated), syncedFlags });
  };
}

async function resolveSyncEnvironments(
  deps: AppEnvironmentDeps,
  appId: string,
  environmentId: string,
  fromEnvironmentId: string,
  requestId: string,
) {
  const target = await deps.repo.identity.getEnvironment(appScope(appId), environmentId);
  if (!target)
    return renderError(
      { code: "ENVIRONMENT_NOT_FOUND", message: "Environment not found", details: {} },
      { requestId },
    );
  if (target.expiresAt === null)
    return environmentKindUnsupported(target, "environments_sync", requestId);
  if (environmentHasExpired(target, nowIso(deps)))
    return renderError(environmentExpiredError(target), { requestId });
  const source = await resolveSyncSource(deps, appId, fromEnvironmentId, requestId);
  if (source instanceof Response) return source;
  if (source.id === target.id)
    return temporaryValidation(
      "Sync source must differ from target",
      ["fromEnvironmentId"],
      requestId,
    );
  return { target, source };
}
