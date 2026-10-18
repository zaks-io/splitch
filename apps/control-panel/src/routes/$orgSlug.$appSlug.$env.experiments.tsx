import { createFileRoute, getRouteApi, Outlet } from "@tanstack/react-router";
import { TemporaryEnvironmentExperiments } from "#components/experiments/temporary-environment-experiments";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { reportRouteError } from "#lib/observability/panel-observability";
import { activeEnvironment } from "#lib/shared/loader-context";
import { documentTitle } from "#lib/shell/document-title";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments")({
  head: ({ params }) => ({
    meta: [{ title: documentTitle("Experiments", params.appSlug, params.env) }],
  }),
  onError: (error: unknown) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments");
  },
  errorComponent: () => <SectionUnavailable title="Experiments unavailable" />,
  pendingComponent: SectionPending,
  component: ExperimentsRoute,
});

function ExperimentsRoute() {
  const context = getRouteApi("/$orgSlug/$appSlug/$env").useLoaderData();
  return activeEnvironment(context).temporary ? <TemporaryEnvironmentExperiments /> : <Outlet />;
}
