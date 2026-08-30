import { createFileRoute } from "@tanstack/react-router";
import { ExperimentTabStub } from "#components/experiments/experiment-detail";
import { ExperimentResultsPanel } from "#components/experiments/experiment-results-panel";
import { useExperimentDetailRouteData } from "#lib/experiments/experiment-detail-route";

export const Route = createFileRoute(
  "/$orgSlug/$appSlug/$env/experiments/$experimentId/runs/$runId/",
)({
  component: AdaptivePinnedRunTab,
});

function AdaptivePinnedRunTab() {
  const route = useExperimentDetailRouteData();
  const run = route.data.runs.find((item) => item.id === route.selectedRunId);
  // An unknown Run id must not read as "this Experiment has no Run yet".
  if (!run) throw new Error("Experiment Run not found");
  if (route.activeTab !== "results") {
    return <ExperimentTabStub run={run} tab={route.activeTab} />;
  }
  return (
    <ExperimentResultsPanel
      appId={route.scope.appId}
      environmentId={route.scope.environmentId}
      experimentId={route.data.experiment.id}
      run={run}
    />
  );
}
