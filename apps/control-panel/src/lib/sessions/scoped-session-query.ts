import { queryOptions } from "@tanstack/react-query";
import { loadScopedSession } from "#lib/sessions/session-functions";
import type { ScopeParams } from "#lib/shared/loader-context";
import { queryKeys } from "#lib/shared/query-keys";

export function scopedSessionQuery(params: ScopeParams, visitPath: string | null) {
  return queryOptions({
    queryKey: queryKeys.session.scopedVisit(params.orgSlug, params.appSlug, params.env, visitPath),
    queryFn: () => loadScopedSession({ data: { ...params, visitPath } }),
    // Authorization is request-local. The QueryClient survives browser
    // navigation, so this result must never become a cross-request grant.
    staleTime: 0,
  });
}
