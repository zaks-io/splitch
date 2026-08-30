import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { queryKeys } from "#lib/shared/query-keys";

/**
 * Re-read one Experiment from the Control Plane after writing to it.
 *
 * Both are needed and neither is redundant: the Experiment detail is served by a
 * React Query cache, so `router.invalidate()` alone re-runs the loaders and
 * leaves the cached row on screen. A wizard step that advanced on a stale read
 * would show the operator the state before their own write — the disguised
 * default ADR-0036 forbids, and the reason no step patches its data locally
 * (ADR-0023).
 */
export function useExperimentDetailRefresh(
  scope: { appId: string; environmentId: string },
  experimentId: string,
) {
  const queryClient = useQueryClient();
  const router = useRouter();

  return async function refresh() {
    await queryClient.invalidateQueries(
      {
        queryKey: queryKeys.experiment.detailPrefix(scope.appId, scope.environmentId, experimentId),
      },
      { throwOnError: true },
    );
    await router.invalidate();
  };
}
