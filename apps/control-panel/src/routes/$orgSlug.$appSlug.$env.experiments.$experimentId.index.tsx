import { createFileRoute } from "@tanstack/react-router";
import { ExperimentTabStub } from "#components/experiment-detail";
import { useExperimentDetailRouteData } from "#lib/experiment-detail-route";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId/")({
  component: AdaptiveExperimentTab,
});

function AdaptiveExperimentTab() {
  const route = useExperimentDetailRouteData();
  return <ExperimentTabStub run={route.data.runs[0]} tab={route.activeTab} />;
}
