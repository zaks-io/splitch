import type { PanelSettingsScope } from "@splitch/control-plane-sdk/panel-settings";
import { queryOptions } from "@tanstack/react-query";
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
