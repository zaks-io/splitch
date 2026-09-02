import { createFileRoute, getRouteApi, Outlet, useRouterState } from "@tanstack/react-router";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { type SettingsTab, SettingsTabs } from "#components/shell/settings-tabs";
import { reportRouteError } from "#lib/observability/panel-observability";
import { documentTitle } from "#lib/shell/document-title";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/settings")({
  head: ({ params }) => ({
    meta: [{ title: documentTitle("Settings", params.appSlug, params.env) }],
  }),
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
