import type { PanelAppSettings } from "@splitch/control-plane-sdk/panel-app-settings";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { loadControlPanelAppSettings } from "#lib/apps/control-plane-app-settings-functions";
import { queryKeys } from "#lib/shared/query-keys";

export function appSettingsQuery(input: { appId: string }) {
  return queryOptions({
    queryKey: queryKeys.app.settings(input.appId),
    queryFn: async () => {
      const result = await loadControlPanelAppSettings({ data: input });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { status: result.status });
      }
      return result.data;
    },
  });
}

export async function refreshAppSettings(
  queryClient: QueryClient,
  input: { appId: string },
): Promise<PanelAppSettings> {
  const queryKey = queryKeys.app.settings(input.appId);
  await queryClient.invalidateQueries({ queryKey }, { throwOnError: true });
  const settings = queryClient.getQueryData<PanelAppSettings>(queryKey);
  if (!settings) {
    throw new Error("App settings were not available after refresh");
  }
  return settings;
}
