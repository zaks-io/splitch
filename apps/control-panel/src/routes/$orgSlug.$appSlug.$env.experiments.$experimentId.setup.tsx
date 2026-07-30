import { createFileRoute } from "@tanstack/react-router";
import { ExperimentSetup } from "#components/experiment-setup";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId/setup")({
  component: ExperimentSetupTab,
});

function ExperimentSetupTab() {
  const route = useExperimentDetailRouteData();
  return (
    <ExperimentSetup
      appId={route.scope.appId}
      data={route.data}
      environmentId={route.scope.environmentId}
      selectedRun={route.data.runs[0]}
    />
  );
}
