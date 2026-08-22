import { createFileRoute, getRouteApi, Outlet, useRouterState } from "@tanstack/react-router";
import { PanelPageBody } from "#components/panel-page-body";
import { SectionUnavailable } from "#components/section-unavailable";
import { type SettingsTab, SettingsTabs } from "#components/settings-tabs";
import { reportRouteError } from "#lib/panel-observability";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/settings")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/settings");
  },
  errorComponent: () => <SectionUnavailable title="Settings unavailable" />,
  component: SettingsSectionLayout,
});

function SettingsSectionLayout() {
  const { scope } = appScopeRoute.useLoaderData();
  const baseHref = `/${scope.orgSlug}/${scope.appSlug}/${scope.env}/settings`;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeTab: SettingsTab = pathname.endsWith("/environment") ? "environment" : "app";

  return (
    <PanelPageBody>
      <div className="grid gap-6">
        <SettingsTabs activeTab={activeTab} baseHref={baseHref} />
        <Outlet />
      </div>
    </PanelPageBody>
  );
}
