import type { CloudflareInstallationStatus } from "@splitch/contracts";
import type { PanelCloudflareScope } from "@splitch/control-plane-sdk/panel-cloudflare";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { loadControlPanelCloudflareInstallations } from "#lib/integrations/control-plane-cloudflare-functions";
import { queryKeys } from "#lib/shared/query-keys";

export function cloudflareInstallationsQuery(input: PanelCloudflareScope) {
  return queryOptions({
    queryKey: queryKeys.environment.cloudflareInstallations(input.appId, input.environmentId),
    queryFn: async () => {
      const result = await loadControlPanelCloudflareInstallations({ data: input });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { status: result.status });
      }
      return result.data.items;
    },
  });
}

export async function refreshCloudflareInstallations(
  queryClient: QueryClient,
  input: PanelCloudflareScope,
): Promise<CloudflareInstallationStatus[]> {
  const queryKey = queryKeys.environment.cloudflareInstallations(input.appId, input.environmentId);
  await queryClient.invalidateQueries({ queryKey }, { throwOnError: true });
  const installations = queryClient.getQueryData<CloudflareInstallationStatus[]>(queryKey);
  if (!installations) {
    throw new Error("Cloudflare installations were not available after refresh");
  }
  return installations;
}
