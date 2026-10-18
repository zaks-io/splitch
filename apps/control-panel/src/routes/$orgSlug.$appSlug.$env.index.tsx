import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { OverviewPage } from "#components/overview/overview-page";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { reportRouteError } from "#lib/observability/panel-observability";
import { loadControlPanelOverview } from "#lib/overview/control-plane-overview-functions";
import { activeEnvironment } from "#lib/shared/loader-context";
import { scopedHref } from "#lib/shell/app-shell-navigation";
import { documentTitle } from "#lib/shell/document-title";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/")({
  loader: async ({ context }) => {
    const scoped = context.scoped;
    const result = await loadControlPanelOverview({
      data: {
        appId: scoped.scope.appId,
        environmentId: scoped.scope.environmentId,
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    const environment = activeEnvironment(scoped);
    return {
      overview: result.data,
      scope: scoped.scope,
      guarded: environment.guarded,
      temporary: environment.temporary !== null,
    };
  },
  head: ({ params }) => ({
    meta: [{ title: documentTitle("Overview", params.appSlug, params.env) }],
  }),
  onError: (error: unknown) => {
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
  const { guarded, overview, scope, temporary } = Route.useLoaderData();
  const router = useRouter();

  return (
    <PanelPageBody>
      <OverviewPage
        env={scope.env}
        guarded={guarded}
        onRetry={() => {
          void router.invalidate();
        }}
        overview={overview}
        scopeHref={scopedHref(scope)}
        temporary={temporary}
      />
    </PanelPageBody>
  );
}
