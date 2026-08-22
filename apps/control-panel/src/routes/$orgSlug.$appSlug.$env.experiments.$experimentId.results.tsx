import { createFileRoute } from "@tanstack/react-router";
import { ExperimentResultsPanel } from "#components/experiment-results-panel";
import { SectionPending } from "#components/section-pending";
import { SectionUnavailable } from "#components/section-unavailable";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId/results")({
  // A Results read that fails must say so. Rendering nothing would read as an
  // Experiment with no numbers rather than as a read that did not complete.
  errorComponent: () => <SectionUnavailable title="Results unavailable" />,
  pendingComponent: SectionPending,
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
