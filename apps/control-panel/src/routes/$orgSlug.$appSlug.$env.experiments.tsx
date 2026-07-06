import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { createFileRoute } from "@tanstack/react-router";
import { reportRouteError } from "#lib/panel-observability";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments");
  },
  errorComponent: () => <SectionErrorPage title="Experiments unavailable" />,
  pendingComponent: TableSkeleton,
  component: ExperimentsSectionRoute,
});

function ExperimentsSectionRoute() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Experiments</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">Experiment Run list surface.</p>
      </CardContent>
    </Card>
  );
}
