import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { EnvironmentSettings } from "#components/environment-settings";
import { loadControlPanelSettings } from "#lib/control-plane-settings-functions";
import { AccessDeniedError } from "#lib/loader-context";
import { reportRouteError } from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/settings")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    const result = await loadControlPanelSettings({ data: scoped.context.scope });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/settings");
  },
  errorComponent: () => <SectionErrorPage title="Settings unavailable" />,
  pendingComponent: PanelSkeleton,
  component: SettingsSectionRoute,
});

function SettingsSectionRoute() {
  return <EnvironmentSettings settings={Route.useLoaderData()} />;
}
