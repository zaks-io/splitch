import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
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
