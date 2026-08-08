import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { SegmentsPage } from "#components/segments-page";
import { loadControlPanelSegments } from "#lib/control-plane-segment-functions";
import { AccessDeniedError } from "#lib/loader-context";
import { reportRouteError } from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/segments")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    const result = await loadControlPanelSegments({ data: scoped.context.scope });
    if (!result.ok) throw new Error(result.error.message);
    return { segments: result.data.items, scope: scoped.context.scope };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/segments");
  },
  errorComponent: () => <SectionErrorPage title="Segments unavailable" />,
  pendingComponent: TableSkeleton,
  component: SegmentsSectionRoute,
});

function SegmentsSectionRoute() {
  const { segments, scope } = Route.useLoaderData();
  return (
    <SegmentsPage appId={scope.appId} environmentId={scope.environmentId} segments={segments} />
  );
}
