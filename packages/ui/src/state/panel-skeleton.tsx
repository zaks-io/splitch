import { Card, CardContent, CardHeader } from "#components/card";
import { Skeleton } from "#components/skeleton";
import { TextSkeleton } from "#state/text-skeleton";

function PanelSkeleton() {
  return (
    <Card data-slot="panel-skeleton">
      <CardHeader>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-48" />
      </CardHeader>
      <CardContent className="grid gap-4">
        <TextSkeleton lines={3} />
        <div className="grid gap-2 sm:grid-cols-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </CardContent>
    </Card>
  );
}

export { PanelSkeleton };
