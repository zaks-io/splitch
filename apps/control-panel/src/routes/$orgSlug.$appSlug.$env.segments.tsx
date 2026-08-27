import { createFileRoute, notFound } from "@tanstack/react-router";
import { PanelPageBody } from "#components/panel-page-body";
import { SectionPending } from "#components/section-pending";
import { SectionUnavailable } from "#components/section-unavailable";
import { SegmentsPage } from "#components/segments-page";
import { loadControlPanelSegments } from "#lib/control-plane-segment-functions";
import { AccessDeniedError } from "#lib/loader-context";
import { loginRedirect } from "#lib/login-redirect";
import { reportRouteError } from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/segments")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    const result = await loadControlPanelSegments({ data: scoped.context.scope });
    if (!result.ok) throw new Error(result.error.message);
    return {
      segments: result.data.items,
      unparseable: result.data.unparseable,
      readLimit: result.data.readLimit,
      readTruncated: result.data.readTruncated,
      scope: scoped.context.scope,
    };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/segments");
  },
  errorComponent: () => <SectionUnavailable title="Segments unavailable" />,
  pendingComponent: SectionPending,
  component: SegmentsSectionRoute,
});

function SegmentsSectionRoute() {
  const { segments, unparseable, readLimit, readTruncated, scope } = Route.useLoaderData();
  return (
    <PanelPageBody>
      <SegmentsPage
        appId={scope.appId}
        environmentId={scope.environmentId}
        readLimit={readLimit}
        readTruncated={readTruncated}
        segments={segments}
        unparseable={unparseable}
      />
    </PanelPageBody>
  );
}
