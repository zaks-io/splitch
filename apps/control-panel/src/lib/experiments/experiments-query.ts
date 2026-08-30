import type {
  PanelExperimentDetailInput,
  PanelExperimentResultsInput,
  PanelExperimentsListInput,
} from "@splitch/control-plane-sdk/panel-experiments";
import { queryOptions } from "@tanstack/react-query";
import {
  loadControlPanelExperimentDetail,
  loadControlPanelExperimentResults,
  loadControlPanelExperiments,
} from "#lib/experiments/control-plane-experiment-functions";
import { queryKeys } from "#lib/shared/query-keys";

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

export function experimentDetailQuery(input: PanelExperimentDetailInput) {
  return queryOptions({
    queryKey: queryKeys.experiment.detail(input.appId, input.environmentId, input.experimentId),
    queryFn: async () => {
      const result = await loadControlPanelExperimentDetail({ data: input });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { status: result.status });
      }
      return result.data;
    },
  });
}

/** Results for one Run. Omitting `runId` reads the live Run; Runs are never pooled. */
export function experimentResultsQuery(input: PanelExperimentResultsInput) {
  return queryOptions({
    queryKey: queryKeys.experiment.results(
      input.appId,
      input.environmentId,
      input.experimentId,
      input.runId ?? "live",
    ),
    queryFn: async () => {
      const result = await loadControlPanelExperimentResults({ data: input });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { status: result.status });
      }
      return result.data;
    },
  });
}
