import { Button } from "@splitch/ui/components/button";
import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import type { QueryClient } from "@tanstack/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, notFound, redirect } from "@tanstack/react-router";
import { ExperimentDraftWizard } from "#components/experiments/experiment-draft-wizard";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { isExperimentDraftStep } from "#lib/experiments/experiment-draft-model";
import { resolveControlPanelExperimentEnvironment } from "#lib/experiments/experiment-environment-resolution-functions";
import {
  experimentKeyRouteRef,
  experimentLookupRef,
} from "#lib/experiments/experiment-route-navigation";
import { experimentDetailQuery } from "#lib/experiments/experiments-query";
import {
  reportExpectedDomainFailure,
  reportRouteError,
} from "#lib/observability/panel-observability";
import type { ScopedLoaderContext } from "#lib/shared/loader-context";
import { scopedHref } from "#lib/shell/app-shell-navigation";

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
  loader: ({ context, location, params }) =>
    loadExperimentDraftRoute({
      queryClient: context.queryClient,
      scoped: context.scoped,
      experimentRef: params.experimentId,
      href: location.href,
      pathname: location.pathname,
    }),
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments/$experimentId/draft");
  },
  errorComponent: () => <SectionUnavailable title="Experiment draft unavailable" />,
  notFoundComponent: ExperimentDraftNotFound,
  pendingComponent: SectionPending,
  component: ExperimentDraftRoute,
});

type ExperimentDraftRouteInput = {
  queryClient: QueryClient;
  scoped: ScopedLoaderContext;
  experimentRef: string;
  href: string;
  pathname: string;
};

export async function loadExperimentDraftRoute(input: ExperimentDraftRouteInput) {
  const app = input.scoped.navigation.orgs
    .find((org) => org.orgId === input.scoped.scope.orgId)
    ?.apps.find((candidate) => candidate.appId === input.scoped.scope.appId);
  if (!app) throw new Error("Active App is missing from navigation");
  const resolved = await resolveControlPanelExperimentEnvironment({
    data: {
      appId: input.scoped.scope.appId,
      targetEnvironmentId: input.scoped.scope.environmentId,
      experimentRef: experimentLookupRef(input.experimentRef),
    },
  });
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error.message), { status: resolved.status });
  }
  if (resolved.data.kind !== "experiment") {
    reportExpectedDomainFailure(404, input.pathname, { boundary: "section" });
    throw notFound();
  }
  if (input.experimentRef !== experimentKeyRouteRef(resolved.data.experimentKey)) {
    const current = new URL(input.href, "https://panel.splitch.dev");
    throw redirect({
      href: `${scopedHref(input.scoped.scope)}/experiments/${experimentKeyRouteRef(resolved.data.experimentKey)}/draft${current.search}${current.hash}`,
    });
  }
  await input.queryClient.ensureQueryData(
    experimentDetailQuery({
      appId: input.scoped.scope.appId,
      environmentId: input.scoped.scope.environmentId,
      experimentId: resolved.data.experimentId,
    }),
  );
  return { experimentId: resolved.data.experimentId };
}

function ExperimentDraftRoute() {
  const context = appScopeRoute.useLoaderData();
  const loaded = Route.useLoaderData();
  if (!loaded) throw new Error("Experiment draft loader returned no route identity");
  const { step } = Route.useSearch();
  const { data } = useSuspenseQuery(
    experimentDetailQuery({
      appId: context.scope.appId,
      environmentId: context.scope.environmentId,
      experimentId: loaded.experimentId,
    }),
  );
  return (
    <PanelPageBody>
      <ExperimentDraftWizard
        data={data}
        scope={context.scope}
        scopeHref={scopedHref(context.scope)}
        step={step}
      />
    </PanelPageBody>
  );
}

function ExperimentDraftNotFound() {
  const context = appScopeRoute.useLoaderData();
  return (
    <PanelPageBody>
      <NotFoundPage
        action={
          <Button
            render={<a href={`${scopedHref(context.scope)}/experiments`}>Experiments</a>}
            variant="outline"
          />
        }
        description="This Experiment does not exist in this Environment."
        title="Experiment not found"
      />
    </PanelPageBody>
  );
}
