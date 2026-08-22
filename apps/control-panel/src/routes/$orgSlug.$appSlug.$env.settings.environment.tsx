import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { EnvironmentSettings } from "#components/environment-settings";
import { reportRouteError } from "#lib/panel-observability";
import { environmentSettingsQuery } from "#lib/settings-query";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/settings/environment")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/settings/environment");
  },
  // The settings layout above owns the body inset, so these render bare.
  errorComponent: () => <SectionErrorPage title="Settings unavailable" />,
  pendingComponent: PanelSkeleton,
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
