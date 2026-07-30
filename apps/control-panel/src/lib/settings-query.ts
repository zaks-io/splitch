import type {
  PanelEnvironmentSettings,
  PanelSettingsScope,
} from "@splitch/control-plane-sdk/panel-settings";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { loadControlPanelSettings } from "./control-plane-settings-functions";
import { queryKeys } from "./query-keys";

export function environmentSettingsQuery(input: PanelSettingsScope) {
  return queryOptions({
    queryKey: queryKeys.environment.settings(input.appId, input.environmentId),
    queryFn: async () => {
      const result = await loadControlPanelSettings({ data: input });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { status: result.status });
      }
      return result.data;
    },
  });
}

export async function refreshEnvironmentSettings(
  queryClient: QueryClient,
  input: PanelSettingsScope,
): Promise<PanelEnvironmentSettings> {
  const queryKey = queryKeys.environment.settings(input.appId, input.environmentId);
  await queryClient.invalidateQueries({ queryKey }, { throwOnError: true });
  const settings = queryClient.getQueryData<PanelEnvironmentSettings>(queryKey);
  if (!settings) {
    throw new Error("Environment settings were not available after refresh");
  }
  return settings;
}
