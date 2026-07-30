import { createFileRoute } from "@tanstack/react-router";
import { ExperimentResultsPanel } from "#components/experiment-results-panel";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute(
  "/$orgSlug/$appSlug/$env/experiments/$experimentId/runs/$runId/results",
)({
  component: PinnedRunResultsTab,
});

function PinnedRunResultsTab() {
  const route = useExperimentDetailRouteData();
  const run = route.data.runs.find((item) => item.id === route.selectedRunId);
  if (!run) throw new Error("Experiment Run not found");
  return (
    <ExperimentResultsPanel
      appId={route.scope.appId}
      environmentId={route.scope.environmentId}
      experimentId={route.data.experiment.id}
      run={run}
    />
  );
}
