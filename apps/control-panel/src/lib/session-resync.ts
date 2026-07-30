import { createRepository } from "@splitch/db";
import type { ControlPanelBindings } from "./bindings";
import { buildSessionPrincipal } from "./membership";
import { refreshSession, type StoredSession } from "./session";

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
): Promise<void> {
  if (!session.workosSessionId) {
    throw new Error("control-panel session is missing its WorkOS session identifier");
  }
  const principal = await buildSessionPrincipal(createRepository(bindings.DB), {
    userId: session.userId,
    workosSessionId: session.workosSessionId,
  });
  await refreshSession(bindings.SESSION_STORE, tokenHash, { ...session, ...principal });
}
