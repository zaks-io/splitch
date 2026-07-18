import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { reportRouteError } from "#lib/panel-observability";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/flags")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/flags");
  },
  errorComponent: () => <SectionErrorPage title="Flags unavailable" />,
  pendingComponent: TableSkeleton,
  component: FlagsSectionRoute,
});

function FlagsSectionRoute() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Flags</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">Flag Configuration list surface.</p>
      </CardContent>
      <Outlet />
    </Card>
  );
}
