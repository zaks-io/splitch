import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { reportRouteError } from "#lib/panel-observability";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments");
  },
  errorComponent: () => <SectionErrorPage title="Experiments unavailable" />,
  pendingComponent: TableSkeleton,
  component: Outlet,
});
