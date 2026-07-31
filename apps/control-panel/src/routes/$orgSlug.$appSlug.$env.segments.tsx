import { createFileRoute } from "@tanstack/react-router";

/**
 * Segments is registered `deferred` in app-shell-navigation.ts. The parent
 * `/$orgSlug/$appSlug/$env` route's loader matches any direct request against
 * the `deferred` registry and throws `notFound()` before this route's own
 * loader or component ever runs (SPL-253) — see `deferredDestinationAt`. The
 * file still has to exist so TanStack Router has something to match; SPL-112
 * replaces this stub with the real screen.
 */
export const Route = createFileRoute("/$orgSlug/$appSlug/$env/segments")({
  component: () => null,
});
