import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ExperimentDetail } from "#components/experiment-detail";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId")({
  component: ExperimentDetailRoute,
});

function ExperimentDetailRoute() {
  const route = useExperimentDetailRouteData();
  return (
    <ExperimentDetail
      activeTab={route.activeTab}
      data={route.data}
      scope={route.scope}
      selectedRunId={route.selectedRunId}
    >
      <Outlet />
    </ExperimentDetail>
  );
}
