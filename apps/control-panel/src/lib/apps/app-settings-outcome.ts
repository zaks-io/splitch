import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import type {
  PanelAppDeleteProgress,
  PanelAppDeleteResult,
} from "@splitch/control-plane-sdk/panel-app-settings";
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

type PartialDeleteFailure = Extract<PanelAppDeleteResult, { ok: false }> & {
  readonly partialDelete: PanelAppDeleteProgress;
};

export type AppDeleteSettlementResult =
  | Extract<PanelAppDeleteResult, { ok: false }>
  | (PartialDeleteFailure & { readonly appDeleted: true })
  | (Extract<PanelAppDeleteResult, { ok: true }> & {
      readonly sessionResync: SessionResync;
    });

export async function settleAppMutation<T>(
  result: ControlPlaneOperationResult<T>,
  resync: () => Promise<void>,
): Promise<AppSettingsMutationResult<T>> {
  if (!result.ok) return result;
  try {
    await resync();
    return { ...result, sessionResync: { ok: true } };
  } catch (cause) {
    return {
      ...result,
      sessionResync: {
        ok: false,
        reason: cause instanceof Error ? cause.message : "the session could not be refreshed",
        remedy: resyncRemedy(cause),
      },
    };
  }
}

/**
 * A forced cascade can cross the App deletion boundary before a later cleanup
 * or response fails. APP_NOT_FOUND proves the boundary crossed, so the same
 * actor resumes required cleanup before deletion is reported as complete.
 */
export async function settleAppDelete(
  result: PanelAppDeleteResult,
  readBack: () => Promise<ControlPlaneOperationResult<unknown>>,
  resume: () => Promise<PanelAppDeleteResult>,
  resync: () => Promise<void>,
): Promise<AppDeleteSettlementResult> {
  if (result.ok) {
    return settleAppMutation(result, result.data.deleted === true ? resync : async () => {});
  }
  const partialDelete = result.partialDelete;
  if (!partialDelete) return result;
  const partialResult: PartialDeleteFailure = { ...result, partialDelete };

  const existence = await readAppExistence(readBack);
  if (existence !== "deleted") return result;

  let resumed: PanelAppDeleteResult;
  try {
    resumed = await resume();
  } catch {
    return afterDeleteBoundary(partialResult, result);
  }
  if (!resumed.ok) return afterDeleteBoundary(partialResult, resumed);
  if (resumed.data.deleted !== true) return afterDeleteBoundary(partialResult, result);
  return settleAppMutation(resumed, resync);
}

async function readAppExistence(
  readBack: () => Promise<ControlPlaneOperationResult<unknown>>,
): Promise<"exists" | "deleted" | "unknown"> {
  try {
    const result = await readBack();
    if (result.ok) return "exists";
    return result.error.code === "APP_NOT_FOUND" ? "deleted" : "unknown";
  } catch {
    return "unknown";
  }
}

function afterDeleteBoundary(
  original: PartialDeleteFailure,
  latest: Extract<PanelAppDeleteResult, { ok: false }>,
): PartialDeleteFailure & { readonly appDeleted: true } {
  return {
    ...latest,
    partialDelete: original.partialDelete,
    appDeleted: true,
  };
}
