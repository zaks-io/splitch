import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, notFound, Outlet, redirect } from "@tanstack/react-router";
import { FlagsPage } from "#components/flags-page";
import { loadControlPanelFlags } from "#lib/control-plane-flag-functions";
import { AccessDeniedError } from "#lib/loader-context";
import { reportRouteError } from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/flags")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    const result = await loadControlPanelFlags({ data: scoped.context.scope });
    if (!result.ok) throw new Error(result.error.message);
    return { items: result.data.items, scope: scoped.context.scope };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/flags");
  },
  errorComponent: () => <SectionErrorPage title="Flags unavailable" />,
  pendingComponent: TableSkeleton,
  component: FlagsSectionRoute,
});

function FlagsSectionRoute() {
  const params = Route.useParams();
  const { items, scope } = Route.useLoaderData();
  return (
    <>
      <FlagsPage
        appId={scope.appId}
        env={scope.env}
        environmentId={scope.environmentId}
        items={items}
        scope={{ orgSlug: params.orgSlug, appSlug: params.appSlug, env: params.env }}
      />
      <Outlet />
    </>
  );
}
