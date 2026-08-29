import { createFileRoute } from "@tanstack/react-router";
import { ExperimentSetup } from "#components/experiment-setup";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId/setup")({
  component: ExperimentSetupTab,
});

function ExperimentSetupTab() {
  const route = useExperimentDetailRouteData();
  // Identity, not array position: this feeds the frozen assignment snapshot, and
  // presenting another Run's frozen config as the current one misstates what is
  // actually bucketing traffic.
  const liveRun = route.data.runs.find((run) => run.id === route.data.experiment.liveRunId);
  return (
    <ExperimentSetup
      appId={route.scope.appId}
      data={route.data}
      environment={route.scope.env}
      environmentId={route.scope.environmentId}
      selectedRun={liveRun ?? route.data.runs[0]}
    />
  );
}
