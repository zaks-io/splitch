import { createAuthKitClient } from "./authkit";
import type { ControlPanelBindings } from "./bindings";
import { destroySession } from "./session";

export const LOGOUT_PATH = "/auth/logout";

/**
 * Signing out destroys the session, so it hangs off an unsafe method only.
 *
 * The CSRF protection is the one every other cookie-authenticated write in the
 * panel already relies on (`claim/consent` is the other one): the session
 * cookie is `SameSite=Lax` (`session-cookie.ts`), which a browser withholds
 * from a cross-site POST, so a forged submit arrives with no session to
 * destroy. `SameSite=Lax` deliberately DOES travel on a top-level GET, which is
 * exactly how a router prefetch, a prerender, a scanner, or a chat client
 * unfurling a pasted link could sign the operator out (SPL-227).
 */
export async function destroyPanelSession(
  bindings: ControlPanelBindings,
  request: Request,
): Promise<Response> {
  const destroyed = await destroySession(bindings.SESSION_STORE, request);
  const returnTo = new URL("/", request.url).toString();
  const location = destroyed.session?.workosSessionId
    ? createAuthKitClient(bindings).getLogoutUrl({
        sessionId: destroyed.session.workosSessionId,
        returnTo,
      })
    : returnTo;

  const headers = new Headers({ "cache-control": "no-store", location });
  headers.append("set-cookie", destroyed.cookie);
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
