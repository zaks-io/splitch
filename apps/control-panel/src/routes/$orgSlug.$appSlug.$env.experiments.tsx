import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { reportRouteError } from "#lib/observability/panel-observability";
import { documentTitle } from "#lib/shell/document-title";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments")({
  head: ({ params }) => ({
    meta: [{ title: documentTitle("Experiments", params.appSlug, params.env) }],
  }),
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments");
  },
  errorComponent: () => <SectionUnavailable title="Experiments unavailable" />,
  pendingComponent: SectionPending,
  component: Outlet,
});
