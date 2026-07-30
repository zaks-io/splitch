import { createFileRoute } from "@tanstack/react-router";
import { ExperimentTabStub } from "#components/experiment-detail";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute(
  "/$orgSlug/$appSlug/$env/experiments/$experimentId/runs/$runId/setup",
)({
  component: PinnedRunSetupTab,
});

function PinnedRunSetupTab() {
  const route = useExperimentDetailRouteData();
  const run = route.data.runs.find((item) => item.id === route.selectedRunId);
  return <ExperimentTabStub run={run} tab="setup" />;
}
