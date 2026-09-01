import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useParams, useRouterState } from "@tanstack/react-router";
import { experimentDetailQuery } from "#lib/experiments/experiments-query";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");
const experimentDetailRoute = getRouteApi("/$orgSlug/$appSlug/$env/experiments/$experimentId");

export type ExperimentTab = "results" | "setup";

export function useExperimentDetailRouteData() {
  const context = appScopeRoute.useLoaderData();
  const resolved = experimentDetailRoute.useLoaderData();
  if (!resolved) throw new Error("Experiment detail loader returned no route identity");
  const params = useParams({ strict: false });
  const { data } = useSuspenseQuery(
    experimentDetailQuery({
      appId: context.scope.appId,
      environmentId: context.scope.environmentId,
      experimentId: resolved.experimentId,
    }),
  );
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return {
    data,
    guarded: resolved.guarded,
    scope: context.scope,
    selectedRunId: typeof params.runId === "string" ? params.runId : undefined,
    activeTab: experimentTab(pathname, data.experiment.status),
  };
}

function experimentTab(pathname: string, status: "draft" | "ended" | "running"): ExperimentTab {
  if (pathname.endsWith("/setup")) return "setup";
  if (pathname.endsWith("/results")) return "results";
  return status === "draft" ? "setup" : "results";
}
