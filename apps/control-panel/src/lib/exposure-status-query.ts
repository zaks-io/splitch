import { queryOptions } from "@tanstack/react-query";
import type { PanelExposureStatusScope } from "@splitch/control-plane-sdk/panel-exposure-status";
import { loadEnvironmentExposureStatus } from "./control-plane-exposure-status-functions";
import { exposureStatusRefetchInterval } from "./exposure-status-polling";
import { queryKeys } from "./query-keys";

export function environmentExposureStatusQuery(input: PanelExposureStatusScope) {
  return queryOptions({
    queryKey: queryKeys.environment.exposureStatus(input.appId, input.environmentId),
    queryFn: async () => {
      const result = await loadEnvironmentExposureStatus({ data: input });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { status: result.status });
      }
      return result.data;
    },
    refetchInterval: (query) =>
      exposureStatusRefetchInterval({
        isError: query.state.status === "error",
        data: query.state.data,
      }),
    retry: false,
  });
}
