import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { ExperimentResultsPanel } from "#components/experiments/experiment-results-panel";
import { useExperimentDetailRouteData } from "#lib/experiments/experiment-detail-route";

export const Route = createFileRoute(
  "/$orgSlug/$appSlug/$env/experiments/$experimentId/runs/$runId/results",
)({
  // A Results read that fails must say so. Rendering nothing would read as an
  // Experiment with no numbers rather than as a read that did not complete.
  // The Experiment detail layout above owns the body inset, so these render bare.
  errorComponent: () => <SectionErrorPage title="Results unavailable" />,
  pendingComponent: TableSkeleton,
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
      metrics={route.data.metrics}
      run={run}
    />
  );
}
