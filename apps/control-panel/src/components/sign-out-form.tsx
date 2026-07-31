import type { ReactNode } from "react";
import { LOGOUT_PATH } from "#lib/logout";

/**
 * The only sign-out affordance in the panel. A form submit is a POST, which is
 * what keeps a link prefetch, a prerender, or a scanner from destroying the
 * session (SPL-227); an anchor to the same path is that bug, so no call site
 * keeps one. Styling stays with the caller so a single action wiring serves the
 * header, the user menu, and the stale-session notice.
 */
export function SignOutForm({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <form action={LOGOUT_PATH} className={className} method="post">
      {children}
    </form>
  );
}
