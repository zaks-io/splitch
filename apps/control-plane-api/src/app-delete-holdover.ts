/**
 * Control Plane orchestration for the durable App holdover deletion saga.
 *
 * @module
 */

import { appScope } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { requireAppDeleteScopes } from "./app-authz";
import { revokeEnvironmentCredentialsForAppDelete } from "./app-environment-credentials";
import { type AppEnvironmentDeps, type EnvironmentRow, appNotFound } from "./app-environment-model";
import { EnvironmentExposureStatusCleanupError } from "./environment-exposure-status-cleanup";
import { HoldoverWriteOutboxCleanupError } from "./holdover-write-outbox-cleanup";

export function renderAppDeleteCleanupError(cause: unknown, requestId: string): Response | null {
  if (cause instanceof EnvironmentExposureStatusCleanupError) {
    return renderError(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "Exposure status cleanup is unavailable",
        details: { retryAfterMs: 30_000 },
      },
      { requestId },
    );
  }
  if (cause instanceof HoldoverWriteOutboxCleanupError) {
    return renderError(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "Holdover write outbox cleanup is unavailable",
        details: { retryAfterMs: 30_000 },
      },
      { requestId },
    );
  }
  return null;
}

export async function deleteAppRowsWithHoldoverSaga(
  deps: AppEnvironmentDeps,
  appId: string,
  organizationId: string,
  environments: readonly EnvironmentRow[],
  actorId: string,
  requestId: string,
): Promise<void> {
  const holdoverCleanup = deps.holdoverWriteOutboxCleanup;
  if (!holdoverCleanup) throw new Error("App delete requires holdover write outbox cleanup");
  const holdoverInput = {
    appId,
    actorId,
    orgId: organizationId,
    requestId,
    deleteBeforeTs: new Date().toISOString(),
  };
  await holdoverCleanup.prepare(holdoverInput);
  try {
    for (const env of environments) {
      await revokeEnvironmentCredentialsForAppDelete(deps, appId, env.id);
    }
    await deps.repo.identity.deleteAppCascade(appScope(appId));
  } catch (cause) {
    await holdoverCleanup.cancel(holdoverInput);
    throw cause;
  }
  await holdoverCleanup.markD1Deleted(holdoverInput);
  await holdoverCleanup.finalize(holdoverInput);
  const cleanup = deps.exposureStatusCleanup;
  if (!cleanup) throw new Error("App delete requires Exposure status cleanup");
  await cleanup.delete({
    appId,
    actorId,
    orgId: organizationId,
    requestId,
  });
}

/**
 * Public DELETE retry after the App row is gone: owner scopes resume pending
 * finalize (never cancel/rollback past the D1 boundary).
 */
export async function resumeHoldoverFinalizeAfterAppGone(
  deps: AppEnvironmentDeps,
  appId: string,
  principal: HandlerArgs<unknown>["principal"],
  requestId: string,
): Promise<Response> {
  const scopeError = requireAppDeleteScopes(appId, principal, requestId);
  if (scopeError) return scopeError;
  const holdoverCleanup = deps.holdoverWriteOutboxCleanup;
  if (!holdoverCleanup) return appNotFound(requestId);
  const holdoverInput = {
    appId,
    actorId: principal.id,
    orgId: principal.orgId ?? null,
    requestId,
  };
  const missing = await tryResumeFinalize(holdoverCleanup, holdoverInput);
  if (missing) return appNotFound(requestId);
  const cleanup = deps.exposureStatusCleanup;
  if (cleanup) {
    await cleanup.delete({
      appId,
      actorId: principal.id,
      orgId: principal.orgId ?? null,
      requestId,
    });
  }
  return Response.json({ deleted: true });
}

async function tryResumeFinalize(
  holdoverCleanup: NonNullable<AppEnvironmentDeps["holdoverWriteOutboxCleanup"]>,
  holdoverInput: {
    appId: string;
    actorId: string;
    orgId: string | null;
    requestId: string;
  },
): Promise<boolean> {
  try {
    await holdoverCleanup.markD1Deleted(holdoverInput);
    await holdoverCleanup.finalize(holdoverInput);
    return false;
  } catch (cause) {
    if (cause instanceof HoldoverWriteOutboxCleanupError && isMissingHoldoverSagaError(cause)) {
      return true;
    }
    throw cause;
  }
}

function isMissingHoldoverSagaError(cause: HoldoverWriteOutboxCleanupError): boolean {
  const message = cause.message.toLowerCase();
  return message.includes("400") || message.includes("no pending") || message.includes("required");
}
