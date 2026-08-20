/**
 * Control Plane orchestration for the durable App holdover deletion saga.
 *
 * @module
 */

import { appScope } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { revokeEnvironmentCredentialsForAppDelete } from "./app-environment-credentials";
import {
  type AppEnvironmentDeps,
  type EnvironmentRow,
  appNotFound,
  nowIso,
} from "./app-environment-model";
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
  const now = nowIso(deps);
  const saga = await deps.repo.identity.beginAppDeletionSaga({
    appId,
    organizationId,
    actorId,
    deleteBeforeTs: now,
    now,
  });
  const holdoverInput = {
    appId,
    actorId,
    orgId: organizationId,
    requestId,
    deleteBeforeTs: saga.deleteBeforeTs,
  };
  try {
    await holdoverCleanup.prepare(holdoverInput);
    for (const env of environments) {
      await revokeEnvironmentCredentialsForAppDelete(deps, appId, env.id);
    }
    await deps.repo.identity.deleteAppCascade(appScope(appId), {
      actorId: saga.actorId,
      organizationId: saga.organizationId,
      deleteBeforeTs: saga.deleteBeforeTs,
      updatedAt: nowIso(deps),
    });
  } catch (cause) {
    const persisted = await deps.repo.identity.getAppDeletionSaga(appId);
    const crossedBoundary = persisted?.phase === "d1_deleted" || persisted?.phase === "complete";
    if (!crossedBoundary) {
      if (persisted?.phase !== "started") {
        throw new Error("App deletion lost its durable D1 recovery record", { cause });
      }
      await holdoverCleanup.cancel(holdoverInput);
      await deps.repo.identity.cancelAppDeletionSaga(appId);
      throw cause;
    }
  }
  await holdoverCleanup.finalize(holdoverInput);
  const cleanup = deps.exposureStatusCleanup;
  if (!cleanup) throw new Error("App delete requires Exposure status cleanup");
  await cleanup.delete({
    appId,
    actorId,
    orgId: organizationId,
    requestId,
  });
  await deps.repo.identity.completeAppDeletionSaga(appId, nowIso(deps));
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
  const saga = await deps.repo.identity.getAppDeletionSaga(appId);
  if (!saga) return appNotFound(requestId);
  if (
    saga.actorId !== principal.id ||
    !principal.scopes.includes(`app:${appId}:owner`) ||
    principal.orgId !== saga.organizationId
  ) {
    return renderError(
      {
        code: "FORBIDDEN",
        message: "credential is not allowed to resume this App deletion",
        details: {},
      },
      { requestId },
    );
  }
  if (saga.phase === "started") {
    throw new HoldoverWriteOutboxCleanupError(
      "control-plane-api: App deletion has not crossed the irreversible boundary",
    );
  }
  if (saga.phase === "complete") return Response.json({ deleted: true });

  const holdoverCleanup = deps.holdoverWriteOutboxCleanup;
  if (!holdoverCleanup) throw new Error("App delete requires holdover write outbox cleanup");
  const holdoverInput = {
    appId,
    actorId: principal.id,
    orgId: saga.organizationId,
    requestId,
  };
  await holdoverCleanup.finalize(holdoverInput);
  const cleanup = deps.exposureStatusCleanup;
  if (!cleanup) throw new Error("App delete requires Exposure status cleanup");
  await cleanup.delete(holdoverInput);
  await deps.repo.identity.completeAppDeletionSaga(appId, nowIso(deps));
  return Response.json({ deleted: true });
}
