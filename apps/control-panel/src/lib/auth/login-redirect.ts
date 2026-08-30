import { redirect } from "@tanstack/react-router";

const LOGIN_PATH = "/auth/login";

/**
 * `/auth/login` has server handlers and no component, so TanStack Start prunes
 * it from the client route tree. During SSR a loader's redirect to it is a 302
 * and reaches the Worker; during a client-side transition the same redirect is
 * an in-app navigation to a route the client does not have, and the router
 * renders Not Found instead of sending the browser to AuthKit. `reloadDocument`
 * makes the client path a full navigation, the only path that reaches the
 * handler. Every loader that gates on the session throws this, never an inline
 * `redirect({ href })`.
 */
export function loginRedirect(returnTo: string) {
  return redirect({
    href: `${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`,
    reloadDocument: true,
  });
}
