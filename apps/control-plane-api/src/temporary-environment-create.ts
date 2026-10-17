import { appScope, envScope } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import {
  ALLOW_POLICY,
  type AppEnvironmentDeps,
  type AppRow,
  type EnvironmentRow,
  environmentResponse,
  nowIso,
} from "./app-environment-model";
import { clientKeyResponse, provisionClientKey } from "./client-key-provisioning";
import { randomHex } from "./credential-cache";
import { environmentCreateConflict } from "./environment-create-conflict";
import { environmentKindUnsupported } from "./temporary-environment-errors";
import {
  copyEnvironmentFlags,
  loadSyncFlags,
  resolveSyncSource,
  TEMPORARY_ENVIRONMENT_LIVE_LIMIT,
  temporaryValidation,
} from "./temporary-environment-sync";
import { teardownTemporaryEnvironment } from "./temporary-environment-teardown";

const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export async function createTemporaryEnvironment(
  deps: AppEnvironmentDeps,
  app: AppRow,
  body: Record<string, unknown>,
  principal: HandlerArgs<unknown>["principal"],
  requestId: string,
): Promise<Response> {
  const id = `env_${randomHex(12)}`;
  if (body.policy !== undefined)
    return environmentKindUnsupported(
      { id, expiresAt: "temporary" },
      "environments_create",
      requestId,
    );
  const temporary = body.temporary as { fromEnvironmentId: string; expiresAt?: string };
  const now = nowIso(deps);
  const expiresAt = resolveTemporaryExpiry(temporary.expiresAt, now, requestId);
  if (expiresAt instanceof Response) return expiresAt;
  const source = await resolveSyncSource(deps, app.id, temporary.fromEnvironmentId, requestId);
  if (source instanceof Response) return source;
  const flags = await loadSyncFlags(deps, app.id, requestId);
  if (flags instanceof Response) return flags;
  let environment: EnvironmentRow | null;
  try {
    environment = await deps.repo.identity.createTemporaryEnvironment(
      appScope(app.id),
      {
        id,
        key: body.key as string,
        name: (body.name as string | undefined) ?? (body.key as string),
        policy: JSON.stringify(ALLOW_POLICY),
        expiresAt,
        syncedFromEnvironmentId: source.id,
        syncedAt: now,
        createdBy: principal.id,
      },
      now,
      TEMPORARY_ENVIRONMENT_LIVE_LIMIT,
    );
  } catch (cause) {
    return environmentCreateConflict(cause, body.key as string, requestId);
  }
  if (!environment) return temporaryEnvironmentLimit(deps, app.id, now, requestId);
  try {
    const copied = await copyEnvironmentFlags(
      deps,
      {
        appId: app.id,
        environmentId: id,
        fromEnvironmentId: source.id,
        actorId: principal.id,
        authKind: principal.kind,
        requestId,
      },
      flags,
    );
    if (copied instanceof Response) {
      await rollback(deps, app, id, principal.id, requestId);
      return copied;
    }
    const clientKey = await provisionClientKey(deps, {
      appId: app.id,
      environmentId: id,
      organizationId: app.organizationId,
      scope: envScope(app.id, id),
    });
    return Response.json({
      ...environmentResponse(environment),
      clientKey: clientKeyResponse(clientKey),
    });
  } catch (cause) {
    await rollback(deps, app, id, principal.id, requestId);
    throw cause;
  }
}

function rollback(
  deps: AppEnvironmentDeps,
  app: AppRow,
  environmentId: string,
  actorId: string,
  requestId: string,
) {
  return teardownTemporaryEnvironment(deps, {
    appId: app.id,
    environmentId,
    orgId: app.organizationId,
    actorId,
    requestId,
  });
}

function resolveTemporaryExpiry(
  value: string | undefined,
  now: string,
  requestId: string,
): string | Response {
  const nowMs = Date.parse(now);
  const expiryMs = value === undefined ? nowMs + MAX_LIFETIME_MS : Date.parse(value);
  if (
    !Number.isFinite(expiryMs) ||
    expiryMs <= nowMs + 60_000 ||
    expiryMs > nowMs + MAX_LIFETIME_MS
  ) {
    return temporaryValidation(
      "Expiry must be more than one minute and at most seven days after creation",
      ["temporary", "expiresAt"],
      requestId,
    );
  }
  return new Date(expiryMs).toISOString();
}

async function temporaryEnvironmentLimit(
  deps: AppEnvironmentDeps,
  appId: string,
  now: string,
  requestId: string,
): Promise<Response> {
  const { active, nextExpiresAt } = await deps.repo.identity.liveTemporaryEnvironmentSummary(
    appScope(appId),
    now,
  );
  if (!nextExpiresAt)
    throw new Error("Temporary Environment limit refused without a live Environment");
  return renderError(
    {
      code: "TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED",
      message: "App has reached its live Temporary Environment limit",
      details: {
        appId,
        limit: TEMPORARY_ENVIRONMENT_LIVE_LIMIT,
        active,
        nextExpiresAt,
        recommendedAction: "DELETE_TEMPORARY_ENVIRONMENT",
      },
    },
    { requestId },
  );
}
