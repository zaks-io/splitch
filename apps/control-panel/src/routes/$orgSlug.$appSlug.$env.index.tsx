import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { OverviewPage } from "#components/overview/overview-page";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { scopedHref } from "#lib/shell/app-shell-navigation";
import { loadControlPanelOverview } from "#lib/overview/control-plane-overview-functions";
import { reportRouteError } from "#lib/observability/panel-observability";

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
    return { overview: result.data, scope: scoped.scope };
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
