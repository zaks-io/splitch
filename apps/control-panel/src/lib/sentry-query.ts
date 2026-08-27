import type { SentryInstallationStatus } from "@splitch/contracts";
import type { PanelSentryScope } from "@splitch/control-plane-sdk/panel-sentry";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { loadControlPanelSentryInstallations } from "./control-plane-sentry-functions";
import { queryKeys } from "./query-keys";

export function sentryInstallationsQuery(input: PanelSentryScope) {
  return queryOptions({
    queryKey: queryKeys.environment.sentryInstallations(input.appId, input.environmentId),
    queryFn: async () => {
      const result = await loadControlPanelSentryInstallations({ data: input });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { status: result.status });
      }
      return result.data.items;
    },
  });
}

export async function refreshSentryInstallations(
  queryClient: QueryClient,
  input: PanelSentryScope,
): Promise<SentryInstallationStatus[]> {
  const queryKey = queryKeys.environment.sentryInstallations(input.appId, input.environmentId);
  await queryClient.invalidateQueries({ queryKey }, { throwOnError: true });
  const installations = queryClient.getQueryData<SentryInstallationStatus[]>(queryKey);
  if (!installations) {
    throw new Error("Sentry installations were not available after refresh");
  }
  return installations;
}
