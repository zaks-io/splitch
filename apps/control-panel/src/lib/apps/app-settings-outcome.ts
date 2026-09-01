import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import type { PanelAppDeleteResult } from "@splitch/control-plane-sdk/panel-app-settings";
import { type ResyncRemedy, resyncRemedy } from "#lib/live-updates/resync-remedy";

/**
 * Renaming an App's URL slug and deleting an App both invalidate the session's
 * own App list: the loader resolves `appSlug` from it, so a session that still
 * carries the old handle turns the next navigation into a 403 on a screen the
 * operator can still see.
 *
 * The mutation already committed in the Control Plane at that point, so a resync
 * failure is NOT a failed mutation and must never be reported as one (SPL-203).
 * It settles as a successful result carrying a loud `sessionResync` failure the
 * screen surfaces on its own terms.
 */
type SessionResync =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly remedy: ResyncRemedy };

export type AppSettingsMutationResult<T> =
  | Extract<ControlPlaneOperationResult<T>, { ok: false }>
  | (Extract<ControlPlaneOperationResult<T>, { ok: true }> & {
      readonly sessionResync: SessionResync;
    });

type DeleteFailure = Extract<PanelAppDeleteResult, { ok: false }>;

export type AppDeleteSettlementResult =
  | DeleteFailure
  | (DeleteFailure & { readonly appDeleted: true; readonly sessionResync: SessionResync })
  | (DeleteFailure & { readonly deleteIndeterminate: true })
  | (Extract<PanelAppDeleteResult, { ok: true }> & {
      readonly sessionResync: SessionResync;
    });

export async function settleAppMutation<T>(
  result: ControlPlaneOperationResult<T>,
  resync: () => Promise<void>,
): Promise<AppSettingsMutationResult<T>> {
  if (!result.ok) return result;
  return { ...result, sessionResync: await settleSessionResync(resync) };
}

async function settleSessionResync(resync: () => Promise<void>): Promise<SessionResync> {
  try {
    await resync();
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : "the session could not be refreshed",
      remedy: resyncRemedy(cause),
    };
  }
}

/**
 * A forced cascade can cross the App deletion boundary before a later cleanup
 * or response fails. One retry lets the same actor resume the durable deletion
 * saga; only the resumed response may prove that the App is gone.
 */
export async function settleAppDelete(
  result: PanelAppDeleteResult,
  resume: () => Promise<PanelAppDeleteResult>,
  resync: () => Promise<void>,
): Promise<AppDeleteSettlementResult> {
  if (result.ok) {
    return settleAppMutation(result, result.data.deleted === true ? resync : async () => {});
  }
  return settleAppDeleteFailure(result, resume, resync);
}

async function settleAppDeleteFailure(
  result: DeleteFailure,
  resume: () => Promise<PanelAppDeleteResult>,
  resync: () => Promise<void>,
): Promise<AppDeleteSettlementResult> {
  if (!shouldResumeDelete(result)) return committedDeleteFailure(result, resync);

  let resumed: PanelAppDeleteResult;
  try {
    resumed = await resume();
  } catch {
    return deleteCommitted(result)
      ? committedDeleteFailure(result, resync)
      : { ...result, deleteIndeterminate: true };
  }
  if (!resumed.ok) {
    const combined = combinePartialDelete(result, resumed);
    return deleteCommitted(result) || deleteCommitted(resumed)
      ? committedDeleteFailure(combined, resync)
      : combined;
  }
  if (resumed.data.deleted !== true) return result;
  return settleAppMutation(resumed, resync);
}

function shouldResumeDelete(result: DeleteFailure): boolean {
  return (
    (result.error.code === "SERVICE_UNAVAILABLE" &&
      (deleteCommitted(result) || result.partialDelete !== undefined)) ||
    errorDetail(result, "fault") === "panel_app_delete_partial_failure"
  );
}

function errorDetail(result: Extract<PanelAppDeleteResult, { ok: false }>, key: string): unknown {
  return (result.error.details as Record<string, unknown>)[key];
}

function deleteCommitted(result: DeleteFailure): boolean {
  return errorDetail(result, "mutationCommitted") === true;
}

async function committedDeleteFailure(
  result: DeleteFailure,
  resync: () => Promise<void>,
): Promise<
  | DeleteFailure
  | (DeleteFailure & { readonly appDeleted: true; readonly sessionResync: SessionResync })
> {
  return deleteCommitted(result)
    ? { ...result, appDeleted: true, sessionResync: await settleSessionResync(resync) }
    : result;
}

function combinePartialDelete(original: DeleteFailure, latest: DeleteFailure): DeleteFailure {
  const originalProgress = original.partialDelete;
  const latestProgress = latest.partialDelete;
  if (!originalProgress) return latest;
  if (!latestProgress) return { ...latest, partialDelete: originalProgress };
  return {
    ...latest,
    partialDelete: {
      removed: uniqueBy(
        [...originalProgress.removed, ...latestProgress.removed],
        ({ childType, id }) => `${childType}:${id}`,
      ),
      appliedApprovalRequestIds: [
        ...new Set([
          ...originalProgress.appliedApprovalRequestIds,
          ...latestProgress.appliedApprovalRequestIds,
        ]),
      ],
    },
  };
}

function uniqueBy<T>(items: readonly T[], keyFor: (item: T) => string): T[] {
  const known = new Set<string>();
  return items.filter((item) => {
    const key = keyFor(item);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
}
