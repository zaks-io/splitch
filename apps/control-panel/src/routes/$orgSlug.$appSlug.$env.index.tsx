import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { OverviewPage } from "#components/overview-page";
import { PanelPageBody } from "#components/panel-page-body";
import { SectionUnavailable } from "#components/section-unavailable";
import { scopedHref } from "#lib/app-shell-navigation";
import { loadControlPanelOverview } from "#lib/control-plane-overview-functions";
import { AccessDeniedError } from "#lib/loader-context";
import { loginRedirect } from "#lib/login-redirect";
import { reportRouteError } from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";

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
