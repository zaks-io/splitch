import type { PanelExperimentsListInput } from "@splitch/control-plane-sdk/panel-experiments";
import { queryOptions } from "@tanstack/react-query";
import { loadControlPanelExperiments } from "./control-plane-experiment-functions";
import { queryKeys } from "./query-keys";

export function experimentsListQuery(input: PanelExperimentsListInput) {
  return queryOptions({
    queryKey: queryKeys.experiment.list(input.appId, input.environmentId),
    queryFn: async () => {
      const result = await loadControlPanelExperiments({ data: input });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { status: result.status });
      }
      return result.data;
    },
  });
}
