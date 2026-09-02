import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { OverviewPage } from "#components/overview/overview-page";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { reportRouteError } from "#lib/observability/panel-observability";
import { loadControlPanelOverview } from "#lib/overview/control-plane-overview-functions";
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
    const environment = scoped.navigation.orgs
      .find((org) => org.orgId === scoped.scope.orgId)
      ?.apps.find((app) => app.appId === scoped.scope.appId)
      ?.environments.find((candidate) => candidate.environmentId === scoped.scope.environmentId);
    if (!environment) throw new Error("Active Environment is missing from App navigation");
    return { overview: result.data, scope: scoped.scope, guarded: environment.guarded };
  },
  head: ({ params }) => ({
    meta: [{ title: documentTitle("Overview", params.appSlug, params.env) }],
  }),
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
  const { guarded, overview, scope } = Route.useLoaderData();
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
      />
    </PanelPageBody>
  );
}
