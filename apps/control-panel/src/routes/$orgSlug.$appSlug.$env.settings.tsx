import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { createFileRoute, getRouteApi, Outlet, useRouterState } from "@tanstack/react-router";
import { type SettingsTab, SettingsTabs } from "#components/settings-tabs";
import { reportRouteError } from "#lib/panel-observability";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/settings")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/settings");
  },
  errorComponent: () => <SectionErrorPage title="Settings unavailable" />,
  component: SettingsSectionLayout,
});

function SettingsSectionLayout() {
  const { scope } = appScopeRoute.useLoaderData();
  const baseHref = `/${scope.orgSlug}/${scope.appSlug}/${scope.env}/settings`;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeTab: SettingsTab = pathname.endsWith("/environment") ? "environment" : "app";

  return (
    <div className="grid gap-6">
      <SettingsTabs activeTab={activeTab} baseHref={baseHref} />
      <Outlet />
    </div>
  );
}
