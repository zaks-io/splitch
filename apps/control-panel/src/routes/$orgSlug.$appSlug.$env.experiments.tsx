import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { reportRouteError } from "#lib/observability/panel-observability";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments");
  },
  errorComponent: () => <SectionUnavailable title="Experiments unavailable" />,
  pendingComponent: SectionPending,
  component: Outlet,
});
