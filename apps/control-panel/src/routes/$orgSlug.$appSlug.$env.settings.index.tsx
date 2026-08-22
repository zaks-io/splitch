import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { AppSettings } from "#components/app-settings";
import { PanelPageBody } from "#components/panel-page-body";
import { SectionUnavailable } from "#components/section-unavailable";
import { appSettingsQuery } from "#lib/app-settings-query";
import { reportRouteError } from "#lib/panel-observability";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/settings/")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/settings/");
  },
  errorComponent: () => <SectionUnavailable title="Settings unavailable" />,
  pendingComponent: () => (
    <PanelPageBody>
      <PanelSkeleton />
    </PanelPageBody>
  ),
  component: AppSettingsRoute,
});

function AppSettingsRoute() {
  const { navigation, scope } = appScopeRoute.useLoaderData();
  const { data } = useSuspenseQuery(appSettingsQuery({ appId: scope.appId }));
  // The danger zone names the Environments it destroys, and the scope loader
  // already resolved them for this App. Naming them from the same list the
  // sidebar renders means the confirmation cannot describe a different App.
  const environmentNames = navigation.orgs
    .flatMap((org) => org.apps)
    .find((app) => app.appId === scope.appId)
    ?.environments.map((environment) => environment.name);
  if (!environmentNames) {
    throw new Error(`Scope navigation has no Environments for App ${scope.appId}`);
  }

  return (
    <AppSettings
      env={scope.env}
      environmentNames={environmentNames}
      orgSlug={scope.orgSlug}
      settings={data}
    />
  );
}
