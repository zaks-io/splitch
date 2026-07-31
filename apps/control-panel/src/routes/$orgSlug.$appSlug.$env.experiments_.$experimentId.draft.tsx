import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { ExperimentDraftWizard } from "#components/experiment-draft-wizard";
import { scopedHref } from "#lib/app-shell-navigation";
import { isExperimentDraftStep } from "#lib/experiment-draft-model";
import { experimentDetailQuery } from "#lib/experiments-query";
import { reportRouteError } from "#lib/panel-observability";

const appScopeRoute = getRouteApi("/$orgSlug/$appSlug/$env");

/**
 * The Experiment-creation flow after step 1. It sits OUTSIDE the Experiment
 * detail layout on purpose: detail renders Results/Setup for an Experiment that
 * has Runs, and a draft has none, so nesting it there would show tabs onto
 * screens with nothing behind them.
 */
export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments_/$experimentId/draft")({
  validateSearch: (search: Record<string, unknown>) => ({
    step: isExperimentDraftStep(search.step) ? search.step : ("measurement" as const),
  }),
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments/$experimentId/draft");
  },
  errorComponent: () => <SectionErrorPage title="Experiment draft unavailable" />,
  pendingComponent: TableSkeleton,
  component: ExperimentDraftRoute,
});

function ExperimentDraftRoute() {
  const context = appScopeRoute.useLoaderData();
  const { experimentId } = Route.useParams();
  const { step } = Route.useSearch();
  const { data } = useSuspenseQuery(
    experimentDetailQuery({
      appId: context.scope.appId,
      environmentId: context.scope.environmentId,
      experimentId,
    }),
  );
  return (
    <ExperimentDraftWizard
      data={data}
      scope={context.scope}
      scopeHref={scopedHref(context.scope)}
      step={step}
    />
  );
}
