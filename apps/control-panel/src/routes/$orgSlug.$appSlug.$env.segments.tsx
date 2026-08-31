import { createFileRoute } from "@tanstack/react-router";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { SegmentsPage } from "#components/segments/segments-page";
import { loadControlPanelSegments } from "#lib/segments/control-plane-segment-functions";
import { reportRouteError } from "#lib/observability/panel-observability";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/segments")({
  loader: async ({ context }) => {
    const scoped = context.scoped;
    const result = await loadControlPanelSegments({ data: scoped.scope });
    if (!result.ok) throw new Error(result.error.message);
    return {
      segments: result.data.items,
      unparseable: result.data.unparseable,
      readLimit: result.data.readLimit,
      readTruncated: result.data.readTruncated,
      scope: scoped.scope,
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
