import { createRepository } from "@splitch/db";
import type { ControlPanelBindings } from "#lib/shared/bindings";
import { buildSessionPrincipal } from "#lib/sessions/membership";
import { clearPendingResync } from "#lib/live-updates/pending-resync";
import { RemediableSessionError, refreshSession, type StoredSession } from "#lib/sessions/session";

/**
 * Narrowed to the two bindings this actually touches. The callers hold the full
 * mutation bindings; a resync has no business reaching the Control Plane fetcher
 * or the delegation secret.
 */
type SessionResyncBindings = Pick<ControlPanelBindings, "DB" | "SESSION_STORE">;

/**
 * Rebuilds the session's membership snapshot from D1 after a mutation that
 * changed what the User can reach.
 *
 * A newly created Organization or App carries a membership row the session
 * snapshot predates, so without this the resource the User just created is
 * absent from the list they are about to land on.
 *
 * The whole principal is spread in, NOT a hand-picked `orgs` field. Two copies
 * of this function previously each copied `orgs` alone, so `orgsTruncated` was
 * silently dropped on the write: a User who created an Organization while at
 * the cap got `outcome: "created"`, was redirected to it, and bounced back to a
 * list that neither contained it nor admitted anything was missing. Spreading
 * the principal means a field added to it can never again be lost between
 * building the snapshot and storing it.
 */
export async function resyncSessionMemberships(
  bindings: SessionResyncBindings,
  tokenHash: string,
  session: StoredSession,
): Promise<StoredSession> {
  if (!session.workosSessionId) {
    throw new RemediableSessionError(
      "control-panel session is missing its WorkOS session identifier",
    );
  }
  const principal = await buildSessionPrincipal(createRepository(bindings.DB), {
    userId: session.userId,
    workosSessionId: session.workosSessionId,
  });
  const refreshed: StoredSession = { ...session, ...principal };
  await refreshSession(bindings.SESSION_STORE, tokenHash, refreshed);
  // A resync that reaches here succeeded, so whatever earlier create left this
  // marker behind (SPL-203) is resolved: the fresh principal now holds it.
  await clearPendingResync(bindings.SESSION_STORE, tokenHash);
  return refreshed;
}

/**
 * The read-path half of "Reload to check again" (`stale-session-notice.tsx`):
 * called from a loader that just found a pending marker, so the retry button
 * is an honest promise instead of dead copy (SPL-203 review round 2,
 * Blocker 2). `resyncSessionMemberships` has exactly two production callers
 * before this one, both create handlers, and nothing on a normal page load
 * ever re-attempted the resync — a reload re-read the identical stale
 * principal forever, until the marker's TTL expired and the App or
 * Organization vanished from view with no explanation at all.
 *
 * Swallows failure on purpose: a caller reached here because it is about to
 * render the stale-session notice regardless, and a failed retry must not
 * turn a read into a thrown error. The still-pending marker (unchanged, since
 * `resyncSessionMemberships` only clears it on success) is what the caller
 * re-reads to keep showing the notice honestly.
 *
 * The fallback is deliberate; the silence is not (ADR-0036). If this fails on
 * every load for an operator, "Reload to check again" is quietly lying again
 * and nothing else says so — `console.warn` is the closest local convention
 * (`live-updates.ts`).
 */
export async function retryPendingResync(
  bindings: SessionResyncBindings,
  tokenHash: string,
  session: StoredSession,
): Promise<StoredSession> {
  try {
    return await resyncSessionMemberships(bindings, tokenHash, session);
  } catch (cause) {
    console.warn(`Failed to retry a pending resync for User "${session.userId}"`, cause);
    return session;
  }
}
