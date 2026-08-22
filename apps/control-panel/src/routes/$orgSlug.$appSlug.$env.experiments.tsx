import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionPending } from "#components/section-pending";
import { SectionUnavailable } from "#components/section-unavailable";
import { reportRouteError } from "#lib/panel-observability";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments");
  },
  errorComponent: () => <SectionUnavailable title="Experiments unavailable" />,
  pendingComponent: SectionPending,
  component: Outlet,
});
