import { Button } from "@splitch/ui/components/button";
import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound, Outlet, redirect } from "@tanstack/react-router";
import { ActiveEnvironmentBadge } from "#components/environments/active-environment-badge";
import { ExperimentDetail } from "#components/experiments/experiment-detail";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { useExperimentDetailRouteData } from "#lib/experiments/experiment-detail-route";
import {
  type ExperimentEnvironmentResolution,
  resolveControlPanelExperimentEnvironment,
} from "#lib/experiments/experiment-environment-resolution-functions";
import {
  canonicalExperimentHref,
  experimentKeyRouteRef,
  type ExperimentNotFoundData,
  experimentNotFoundData,
  experimentRouteReference,
} from "#lib/experiments/experiment-route-navigation";
import { experimentDetailQuery } from "#lib/experiments/experiments-query";
import { reportExpectedDomainFailure } from "#lib/observability/panel-observability";
import type { ScopedLoaderContext } from "#lib/shared/loader-context";
import { scopedHref } from "#lib/shell/app-shell-navigation";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/$experimentId")({
  loader: ({ context, location, params }) =>
    loadExperimentRoute({
      queryClient: context.queryClient,
      scoped: context.scoped,
      experimentRef: params.experimentId,
      href: location.href,
      pathname: location.pathname,
    }),
  notFoundComponent: ExperimentRouteNotFound,
  component: ExperimentDetailRoute,
});

type ExperimentRouteInput = {
  queryClient: QueryClient;
  scoped: ScopedLoaderContext;
  experimentRef: string;
  href: string;
  pathname: string;
};

export async function loadExperimentRoute(input: ExperimentRouteInput) {
  const environments = currentAppEnvironments(input.scoped);
  const activeEnvironment = environments.find(
    (environment) => environment.environmentId === input.scoped.scope.environmentId,
  );
  if (!activeEnvironment) throw new Error("Active Environment is missing from App navigation");
  const runId = experimentRunId(input.pathname);
  const resolved = await resolveControlPanelExperimentEnvironment({
    data: {
      appId: input.scoped.scope.appId,
      targetEnvironmentId: input.scoped.scope.environmentId,
      ...experimentRouteReference(input.experimentRef),
      runId,
    },
  });
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error.message), { status: resolved.status });
  }
  if (resolved.data.kind !== "experiment") {
    throwResolvedNotFound(resolved.data, input.scoped.scope, input.href);
  }
  if (input.experimentRef !== experimentKeyRouteRef(resolved.data.experimentKey)) {
    throw redirect({
      href: canonicalExperimentHref(
        input.scoped.scope,
        resolved.data.experimentKey,
        input.href,
        runId,
      ),
    });
  }
  await input.queryClient.ensureQueryData(
    experimentDetailQuery({
      appId: input.scoped.scope.appId,
      environmentId: input.scoped.scope.environmentId,
      experimentId: resolved.data.experimentId,
    }),
  );
  return { experimentId: resolved.data.experimentId, guarded: activeEnvironment.guarded };
}

function ExperimentDetailRoute() {
  const route = useExperimentDetailRouteData();
  return (
    <PanelPageBody className="mx-auto w-full max-w-6xl">
      <ExperimentDetail
        activeTab={route.activeTab}
        data={route.data}
        guarded={route.guarded}
        scope={route.scope}
        selectedRunId={route.selectedRunId}
      >
        <Outlet />
      </ExperimentDetail>
    </PanelPageBody>
  );
}

function ExperimentRouteNotFound({ data }: { data?: unknown }) {
  const scoped = Route.useRouteContext().scoped;
  const missing = data as ExperimentNotFoundData | undefined;
  const env = missing?.env ?? scoped.scope.env;
  const runElsewhere = missing?.kind === "run_elsewhere" ? missing : undefined;
  const description = runElsewhere
    ? `This Run belongs to the ${runElsewhere.sourceEnv} Environment.`
    : missing?.kind === "run"
      ? "No Run with this ID exists for this Experiment in any Environment."
      : `This Experiment does not exist in the ${env} Environment.`;
  return (
    <PanelPageBody>
      <NotFoundPage
        action={
          runElsewhere ? (
            <Button render={<a href={runElsewhere.href}>Open in {runElsewhere.sourceEnv}</a>} />
          ) : (
            <Button
              render={<a href={`${scopedHref(scoped.scope)}/experiments`}>Experiments</a>}
              variant="outline"
            />
          )
        }
        description={
          <span className="grid justify-items-center gap-3">
            <ActiveEnvironmentBadge env={scoped.scope.env} />
            <span>{description}</span>
          </span>
        }
        title={missing?.kind === "experiment" ? "Experiment not found" : "Run not found"}
      />
    </PanelPageBody>
  );
}

function currentAppEnvironments(scoped: ScopedLoaderContext) {
  const app = scoped.navigation.orgs
    .find((org) => org.orgId === scoped.scope.orgId)
    ?.apps.find((candidate) => candidate.appId === scoped.scope.appId);
  if (!app) throw new Error("Active App is missing from navigation");
  return app.environments;
}

function throwResolvedNotFound(
  resolution: ExperimentEnvironmentResolution,
  scope: { orgSlug: string; appSlug: string; env: string },
  currentHref: string,
): never {
  reportExpectedDomainFailure(404, new URL(currentHref, "https://panel.splitch.dev").pathname, {
    boundary: "section",
  });
  if (resolution.kind === "experiment") {
    throw new Error("Experiment resolution returned an unexpected local Experiment");
  }
  throw notFound({ data: experimentNotFoundData(resolution, scope, currentHref) });
}

function experimentRunId(pathname: string): string | undefined {
  const encoded = pathname.match(/\/runs\/([^/]+)/)?.[1];
  return encoded ? decodeURIComponent(encoded) : undefined;
}
