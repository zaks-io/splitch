import type { QueryClient } from "@tanstack/react-query";
import { loadAppSettingsPage } from "#lib/apps/app-settings-page-functions";
import { queryKeys } from "#lib/shared/query-keys";

interface AppSettingsPageScope {
  appId: string;
  environmentId: string;
}

export async function prefetchAppSettingsPage(
  queryClient: QueryClient,
  scope: AppSettingsPageScope,
): Promise<void> {
  const queryKey = queryKeys.app.settingsPage(scope.appId, scope.environmentId);
  try {
    const result = await queryClient.fetchQuery({
      queryKey,
      queryFn: () => loadAppSettingsPage({ data: scope }),
    });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { status: result.status });
    const { appSettings, environmentSettings, exposureStatus } = result.data;
    if (!appSettings.ok) {
      throw Object.assign(new Error(appSettings.error.message), { status: appSettings.status });
    }
    queryClient.setQueryData(queryKeys.app.settings(scope.appId), appSettings.data);
    if (environmentSettings.ok) {
      queryClient.setQueryData(
        queryKeys.environment.settings(scope.appId, scope.environmentId),
        environmentSettings.data,
      );
    }
    if (exposureStatus.ok) {
      queryClient.setQueryData(
        queryKeys.environment.exposureStatus(scope.appId, scope.environmentId),
        exposureStatus.data,
      );
    }
  } finally {
    queryClient.removeQueries({ queryKey, exact: true });
  }
}
