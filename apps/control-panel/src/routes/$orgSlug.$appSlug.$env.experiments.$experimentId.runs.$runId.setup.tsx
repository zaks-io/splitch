import { createFileRoute } from "@tanstack/react-router";
import { ExperimentSetup } from "#components/experiment-setup";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute(
  "/$orgSlug/$appSlug/$env/experiments/$experimentId/runs/$runId/setup",
)({
  component: PinnedRunSetupTab,
});

function PinnedRunSetupTab() {
  const route = useExperimentDetailRouteData();
  const run = route.data.runs.find((item) => item.id === route.selectedRunId);
  return (
    <ExperimentSetup
      appId={route.scope.appId}
      data={route.data}
      environment={route.scope.env}
      environmentId={route.scope.environmentId}
      selectedRun={run}
    />
  );
}
