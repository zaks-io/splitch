import type { ConvexInstallationStatus } from "@splitch/contracts";
import type { PanelConvexScope } from "@splitch/control-plane-sdk/panel-convex";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { loadControlPanelConvexInstallations } from "#lib/integrations/control-plane-convex-functions";
import { queryKeys } from "#lib/shared/query-keys";

export function convexInstallationsQuery(input: PanelConvexScope) {
  return queryOptions({
    queryKey: queryKeys.environment.convexInstallations(input.appId, input.environmentId),
    queryFn: async () => {
      const result = await loadControlPanelConvexInstallations({ data: input });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { status: result.status });
      }
      return result.data.items;
    },
  });
}

export async function refreshConvexInstallations(
  queryClient: QueryClient,
  input: PanelConvexScope,
): Promise<ConvexInstallationStatus[]> {
  const queryKey = queryKeys.environment.convexInstallations(input.appId, input.environmentId);
  await queryClient.invalidateQueries({ queryKey }, { throwOnError: true });
  const installations = queryClient.getQueryData<ConvexInstallationStatus[]>(queryKey);
  if (!installations) {
    throw new Error("Convex installations were not available after refresh");
  }
  return installations;
}
