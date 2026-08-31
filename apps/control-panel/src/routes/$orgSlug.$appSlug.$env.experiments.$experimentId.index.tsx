import { createFileRoute } from "@tanstack/react-router";
import { ExperimentTabStub } from "#components/experiments/experiment-detail";
import { ExperimentResultsPanel } from "#components/experiments/experiment-results-panel";
import { useExperimentDetailRouteData } from "#lib/experiments/experiment-detail-route";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId/")({
  component: AdaptiveExperimentTab,
});

function AdaptiveExperimentTab() {
  const route = useExperimentDetailRouteData();
  if (route.activeTab !== "results") {
    return <ExperimentTabStub run={route.data.runs[0]} tab={route.activeTab} />;
  }
  return (
    <ExperimentResultsPanel
      appId={route.scope.appId}
      environmentId={route.scope.environmentId}
      experimentId={route.data.experiment.id}
      metrics={route.data.metrics}
      run={route.data.runs[0]}
    />
  );
}
