import type { PanelAppDeleteProgress } from "@splitch/control-plane-sdk/panel-app-settings";
import {
  deleteControlPanelApp,
  updateControlPanelApp,
} from "#lib/apps/control-plane-app-settings-functions";
import type { ResyncRemedy } from "#lib/live-updates/resync-remedy";

/**
 * The two App Settings mutations that can end four different ways, resolved to a
 * single outcome the screen can render without re-deriving it.
 *
 * A Worker refusal, a committed mutation whose session could not be refreshed
 * (SPL-203), and a transport failure are three distinct states, and collapsing
 * any of them into a generic error would hide which one happened (ADR-0036).
 */

type Stale = { readonly reason: string; readonly remedy: ResyncRemedy };

export type RenameOutcome =
  | { readonly kind: "refused"; readonly message: string }
  | ({ readonly kind: "stale" } & Stale)
  /** The slug changed, so every URL for this App including the current one moved. */
  | { readonly kind: "moved"; readonly key: string }
  | { readonly kind: "saved" };

export async function renameApp(input: {
  appId: string;
  currentKey: string;
  key: string;
  name: string;
}): Promise<RenameOutcome> {
  let result: Awaited<ReturnType<typeof updateControlPanelApp>>;
  try {
    result = await updateControlPanelApp({
      data: { appId: input.appId, key: input.key, name: input.name },
    });
  } catch {
    return {
      kind: "refused",
      message: "The Control Plane did not answer. This App may or may not have been renamed.",
    };
  }
  if (!result.ok) return { kind: "refused", message: result.error.message };
  // The App is renamed either way. A session that could not be refreshed is a
  // separate, loud problem and must never be reported as a failed rename.
  if (!result.sessionResync.ok) return { kind: "stale", ...result.sessionResync };
  return result.data.key === input.currentKey
    ? { kind: "saved" }
    : { kind: "moved", key: result.data.key };
}

export type DeleteOutcome =
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "indeterminate"; readonly message: string }
  | { readonly kind: "cleanup-pending"; readonly message: string }
  | {
      readonly kind: "partially-deleted";
      readonly message: string;
      readonly removedCount: number;
    }
  | ({ readonly kind: "stale" } & Stale)
  | { readonly kind: "deleted" };

export async function destroyApp(appId: string): Promise<DeleteOutcome> {
  let result: Awaited<ReturnType<typeof deleteControlPanelApp>>;
  try {
    // `force` cascades exactly the tree the confirmation named. Without it the
    // Control Plane refuses any App that is not already empty, which would make
    // that confirmation a promise this button cannot keep.
    result = await deleteControlPanelApp({ data: { appId, force: true } });
  } catch {
    return {
      kind: "indeterminate",
      message: "The Control Plane did not answer.",
    };
  }
  return deleteOutcome(result);
}

function deleteOutcome(result: Awaited<ReturnType<typeof deleteControlPanelApp>>): DeleteOutcome {
  if (!result.ok) return failedDeleteOutcome(result);
  if (result.data.deleted !== true) {
    return {
      kind: "refused",
      message: "The Control Plane did not delete this App.",
    };
  }
  if (!result.sessionResync.ok) return { kind: "stale", ...result.sessionResync };
  return { kind: "deleted" };
}

function failedDeleteOutcome(
  result: Extract<Awaited<ReturnType<typeof deleteControlPanelApp>>, { ok: false }>,
): DeleteOutcome {
  if ("appDeleted" in result && result.appDeleted === true) {
    return { kind: "cleanup-pending", message: result.error.message };
  }
  if ("deleteIndeterminate" in result && result.deleteIndeterminate === true) {
    return { kind: "indeterminate", message: result.error.message };
  }
  const partialDelete =
    "partialDelete" in result
      ? (result.partialDelete as PanelAppDeleteProgress | undefined)
      : undefined;
  return partialDelete
    ? {
        kind: "partially-deleted",
        message: result.error.message,
        removedCount: partialDelete.removed.length + partialDelete.appliedApprovalRequestIds.length,
      }
    : { kind: "refused", message: result.error.message };
}
