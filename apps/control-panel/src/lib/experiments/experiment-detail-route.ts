import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useParams, useRouterState } from "@tanstack/react-router";
import { experimentDetailQuery } from "#lib/experiments/experiments-query";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

export type ExperimentTab = "results" | "setup";

export function useExperimentDetailRouteData() {
  const context = appScopeRoute.useLoaderData();
  const params = useParams({ strict: false });
  const experimentId = requiredParam(params.experimentId, "experimentId");
  const { data } = useSuspenseQuery(
    experimentDetailQuery({
      appId: context.scope.appId,
      environmentId: context.scope.environmentId,
      experimentId,
    }),
  );
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return {
    data,
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

function requiredParam(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Experiment detail route is missing ${name}`);
}
