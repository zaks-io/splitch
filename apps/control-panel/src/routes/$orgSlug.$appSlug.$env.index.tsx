import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { createFileRoute, notFound, redirect, useRouter } from "@tanstack/react-router";
import { OverviewPage } from "#components/overview-page";
import { scopedHref } from "#lib/app-shell-navigation";
import { loadControlPanelOverview } from "#lib/control-plane-overview-functions";
import { AccessDeniedError } from "#lib/loader-context";
import { reportRouteError } from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
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
  errorComponent: () => <SectionErrorPage title="Overview unavailable" />,
  pendingComponent: PanelSkeleton,
  component: OverviewSectionRoute,
});

function OverviewSectionRoute() {
  const { overview, scope } = Route.useLoaderData();
  const router = useRouter();

  return (
    <OverviewPage
      env={scope.env}
      onRetry={() => {
        void router.invalidate();
      }}
      overview={overview}
      scopeHref={scopedHref(scope)}
    />
  );
}
