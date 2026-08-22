import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { EnvironmentSettings } from "#components/environment-settings";
import { PanelPageBody } from "#components/panel-page-body";
import { SectionUnavailable } from "#components/section-unavailable";
import { reportRouteError } from "#lib/panel-observability";
import { environmentSettingsQuery } from "#lib/settings-query";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/settings/environment")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/settings/environment");
  },
  errorComponent: () => <SectionUnavailable title="Settings unavailable" />,
  pendingComponent: () => (
    <PanelPageBody>
      <PanelSkeleton />
    </PanelPageBody>
  ),
  component: EnvironmentSettingsRoute,
});

function EnvironmentSettingsRoute() {
  const { scope } = appScopeRoute.useLoaderData();
  const { data } = useSuspenseQuery(
    environmentSettingsQuery({
      appId: scope.appId,
      environmentId: scope.environmentId,
    }),
  );
  return <EnvironmentSettings settings={data} />;
}
