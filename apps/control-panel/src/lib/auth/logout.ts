import { createAuthKitClient } from "#lib/auth/authkit";
import type { ControlPanelBindings } from "#lib/shared/bindings";
import { rejectCrossOriginWrite } from "#lib/auth/panel-csrf";
import { LAST_VISITED_COOKIE_NAME } from "#lib/sessions/last-visited-scope";
import { destroySession } from "#lib/sessions/session";
import { appendHttpOnlyCookie, clearHttpOnlyCookie } from "#lib/sessions/session-cookie";

export const LOGOUT_PATH = "/auth/logout";

/**
 * Signing out destroys the session, so it hangs off an unsafe method only.
 *
 * CSRF for this form POST is same-origin `Origin` (`rejectCrossOriginWrite`)
 * plus `SameSite=Lax` on the session cookie. Lax alone is a *site* boundary and
 * is not enough across `*.splitch.dev` — see `session-cookie.ts` (SPL-263).
 * `SameSite=Lax` deliberately DOES travel on a top-level GET, which is how a
 * router prefetch, prerender, scanner, or chat client unfurling a pasted link
 * could sign the operator out (SPL-227).
 */
export async function destroyPanelSession(
  bindings: ControlPanelBindings,
  request: Request,
): Promise<Response> {
  const rejected = rejectCrossOriginWrite(request);
  if (rejected) return rejected;

  const destroyed = await destroySession(bindings.SESSION_STORE, request);
  const returnTo = new URL("/", request.url).toString();
  const location = destroyed.session?.workosSessionId
    ? createAuthKitClient(bindings).getLogoutUrl({
        sessionId: destroyed.session.workosSessionId,
        returnTo,
      })
    : returnTo;

  const headers = new Headers({ "cache-control": "no-store", location });
  appendHttpOnlyCookie(headers, destroyed.cookie);
  // The navigation hint is this user's history; the next person to sign in on
  // the same browser must not be greeted with it.
  appendHttpOnlyCookie(headers, clearHttpOnlyCookie(LAST_VISITED_COOKIE_NAME));
  return new Response(null, { headers, status: 302 });
}

/**
 * A safe method leaves the session alone and says so. The refusal names the
 * method and the route so a non-browser caller can act on it directly instead
 * of being told only that it failed (ADR-0036).
 */
export function refuseSafeLogout(): Response {
  return new Response(
    `Signing out destroys the session, so it requires POST ${LOGOUT_PATH} carrying the session cookie. Use the Sign out control in the Control Panel, or send that POST directly. Your session is untouched.\n`,
    {
      headers: {
        allow: "POST",
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
      status: 405,
    },
  );
}
