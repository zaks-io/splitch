import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ExperimentDetail } from "#components/experiments/experiment-detail";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { useExperimentDetailRouteData } from "#lib/experiments/experiment-detail-route";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId")({
  component: ExperimentDetailRoute,
});

function ExperimentDetailRoute() {
  const route = useExperimentDetailRouteData();
  return (
    <PanelPageBody className="mx-auto w-full max-w-6xl">
      <ExperimentDetail
        activeTab={route.activeTab}
        data={route.data}
        scope={route.scope}
        selectedRunId={route.selectedRunId}
      >
        <Outlet />
      </ExperimentDetail>
    </PanelPageBody>
  );
}
