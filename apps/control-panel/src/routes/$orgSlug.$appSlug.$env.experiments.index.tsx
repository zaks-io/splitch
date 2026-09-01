import { Button } from "@splitch/ui/components/button";
import { Card, CardContent, CardHeader } from "@splitch/ui/components/card";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { ActiveEnvironmentBadge } from "#components/environments/active-environment-badge";
import { ExperimentList } from "#components/experiments/experiment-list";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { experimentsListQuery } from "#lib/experiments/experiments-query";
import { scopedHref } from "#lib/shell/app-shell-navigation";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/")({
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
  const environment = context.navigation.orgs
    .find((org) => org.orgId === context.scope.orgId)
    ?.apps.find((app) => app.appId === context.scope.appId)
    ?.environments.find((candidate) => candidate.environmentId === context.scope.environmentId);
  if (!environment) throw new Error("Active Environment is missing from App navigation");
  return (
    <PanelPageBody>
      <Card className="border-0 bg-transparent shadow-none">
        <CardHeader className="flex flex-row items-start justify-between gap-4 px-0 pt-0">
          <div className="grid gap-1.5">
            <ActiveEnvironmentBadge env={environment.env} guarded={environment.guarded} />
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
    </PanelPageBody>
  );
}
