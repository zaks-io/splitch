import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/segments")({
  component: SegmentsStub,
});

function SegmentsStub() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Segments (App-level)</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">
          Segment management arrives in its dedicated screen slice.
        </p>
      </CardContent>
    </Card>
  );
}
