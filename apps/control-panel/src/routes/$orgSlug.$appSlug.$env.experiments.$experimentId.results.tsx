import { createFileRoute } from "@tanstack/react-router";
import { ExperimentResultsPanel } from "#components/experiment-results-panel";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId/results")({
  component: ExperimentResultsTab,
});

function ExperimentResultsTab() {
  const route = useExperimentDetailRouteData();
  return (
    <ExperimentResultsPanel
      appId={route.scope.appId}
      environmentId={route.scope.environmentId}
      experimentId={route.data.experiment.id}
      run={route.data.runs[0]}
    />
  );
}
