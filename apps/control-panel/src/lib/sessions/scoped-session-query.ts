import { queryOptions } from "@tanstack/react-query";
import type { ScopeParams } from "#lib/shared/loader-context";
import { queryKeys } from "#lib/shared/query-keys";
import { loadScopedSession } from "#lib/sessions/session-functions";

export function scopedSessionQuery(params: ScopeParams) {
  return queryOptions({
    queryKey: queryKeys.session.scope(params.orgSlug, params.appSlug, params.env),
    queryFn: () => loadScopedSession({ data: params }),
    // Authorization is request-local. The QueryClient survives browser
    // navigation, so this result must never become a cross-request grant.
    staleTime: 0,
  });
}
