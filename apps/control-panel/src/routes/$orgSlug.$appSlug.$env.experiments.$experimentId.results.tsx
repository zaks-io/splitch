import { createFileRoute } from "@tanstack/react-router";
import { ExperimentTabStub } from "#components/experiment-detail";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId/results")({
  component: ExperimentResultsTab,
});

function ExperimentResultsTab() {
  const route = useExperimentDetailRouteData();
  return <ExperimentTabStub run={route.data.runs[0]} tab="results" />;
}
