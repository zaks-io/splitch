import { Button } from "@splitch/ui/components/button";
import { Card, CardContent, CardHeader } from "@splitch/ui/components/card";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { ExperimentList } from "#components/experiment-list";
import { scopedHref } from "#lib/app-shell-navigation";
import { experimentsListQuery } from "#lib/experiments-query";
import { reportRouteError } from "#lib/panel-observability";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments");
  },
  errorComponent: () => <SectionErrorPage title="Experiments unavailable" />,
  pendingComponent: TableSkeleton,
  component: ExperimentsSectionRoute,
});

function ExperimentsSectionRoute() {
  const context = appScopeRoute.useLoaderData();
  const { data } = useSuspenseQuery(
    experimentsListQuery({
      appId: context.scope.appId,
      environmentId: context.scope.environmentId,
    }),
  );
  const rootHref = scopedHref(context.scope);
  return (
    <Card className="border-0 bg-transparent shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-4 px-0 pt-0">
        <div className="grid gap-1.5">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
            {context.scope.env} Environment
          </p>
          <h1 className="font-semibold text-3xl text-foreground tracking-tight">Experiments</h1>
          <p className="max-w-2xl text-muted-foreground text-sm leading-6">
            Track lifecycle and live Run health for every Experiment in this Environment.
          </p>
        </div>
        {data.items.length > 0 ? (
          <Button render={<a href={`${rootHref}/experiments/new`}>New Experiment</a>} />
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        <ExperimentList items={data.items} scopeHref={rootHref} />
      </CardContent>
    </Card>
  );
}
