import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/metrics")({
  component: MetricsStub,
});

function MetricsStub() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Metrics (App-level)</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">
          Metric management arrives in its dedicated screen slice.
        </p>
      </CardContent>
    </Card>
  );
}
