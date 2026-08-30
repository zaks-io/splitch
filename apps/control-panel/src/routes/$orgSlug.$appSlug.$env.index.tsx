import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { OverviewPage } from "#components/overview/overview-page";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { scopedHref } from "#lib/shell/app-shell-navigation";
import { loadControlPanelOverview } from "#lib/overview/control-plane-overview-functions";
import { AccessDeniedError } from "#lib/shared/loader-context";
import { loginRedirect } from "#lib/auth/login-redirect";
import { reportRouteError } from "#lib/observability/panel-observability";
import { loadScopedSession } from "#lib/sessions/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    const result = await loadControlPanelOverview({
      data: {
        appId: scoped.context.scope.appId,
        environmentId: scoped.context.scope.environmentId,
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    return { overview: result.data, scope: scoped.context.scope };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/");
  },
  errorComponent: () => <SectionUnavailable title="Overview unavailable" />,
  pendingComponent: () => (
    <PanelPageBody>
      <PanelSkeleton />
    </PanelPageBody>
  ),
  component: OverviewSectionRoute,
});

function OverviewSectionRoute() {
  const { overview, scope } = Route.useLoaderData();
  const router = useRouter();

  return (
    <PanelPageBody>
      <OverviewPage
        env={scope.env}
        onRetry={() => {
          void router.invalidate();
        }}
        overview={overview}
        scopeHref={scopedHref(scope)}
      />
    </PanelPageBody>
  );
}
