export type ResyncRemedy = "reauth" | "retry";

/**
 * Classifies a resync failure by what actually fixes it, not by parsing error
 * text.
 *
 * Signing in again re-runs the exact `buildSessionPrincipal` call that just
 * threw (`authkit.ts`'s callback calls it too). That repairs the two failure
 * modes that are about the session's own identity — a missing WorkOS session
 * id, a session that expired before it could be refreshed — because the
 * callback mints a new one. It repairs nothing else: a D1 outage, a KV outage,
 * or a corrupt membership row (an unknown role, a duplicate handle, a missing
 * Organization) reproduces identically on the callback, so offering "sign in
 * again" there would trade a stale-but-signed-in session for a dead one
 * (`/auth/logout` destroys the session before WorkOS is even reached).
 *
 * `RemediableSessionError` (`session.ts`, `session-resync.ts`) tags the two
 * reauth-fixable throws with `remedy: "reauth"`. Everything else defaults to
 * `"retry"` — the safe default, since claiming re-auth works when it does not
 * is the impossible-remedy shape ADR-0036 forbids, and defaulting to "retry"
 * only ever under-promises.
 *
 * Duck-typed on purpose: importing the error classes would pull `session.ts`,
 * and transitively `@splitch/db`, into the browser bundle this file loads
 * into (`create-app-outcome.ts`, `create-organization-outcome.ts`).
 */
export function resyncRemedy(cause: unknown): ResyncRemedy {
  return cause instanceof Error && (cause as { remedy?: unknown }).remedy === "reauth"
    ? "reauth"
    : "retry";
}
