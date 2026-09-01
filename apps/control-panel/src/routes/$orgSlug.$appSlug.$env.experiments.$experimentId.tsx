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
import { experimentDetailQuery, experimentsListQuery } from "#lib/experiments/experiments-query";
import { reportExpectedDomainFailure } from "#lib/observability/panel-observability";
import type { ScopedLoaderContext } from "#lib/shared/loader-context";
import { scopedHref } from "#lib/shell/app-shell-navigation";

type ExperimentNotFoundData =
  | { kind: "experiment"; env: string }
  | { kind: "run"; env: string }
  | { kind: "run_elsewhere"; env: string; sourceEnv: string; href: string };

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

async function loadExperimentRoute(input: ExperimentRouteInput) {
  const environments = currentAppEnvironments(input.scoped);
  const activeEnvironment = environments.find(
    (environment) => environment.environmentId === input.scoped.scope.environmentId,
  );
  if (!activeEnvironment) throw new Error("Active Environment is missing from App navigation");
  const catalog = await input.queryClient.ensureQueryData(
    experimentsListQuery({
      appId: input.scoped.scope.appId,
      environmentId: input.scoped.scope.environmentId,
    }),
  );
  const matches = catalog.items.filter(
    (experiment) => experiment.id === input.experimentRef || experiment.key === input.experimentRef,
  );
  if (matches.length > 1) {
    throw new Error("Experiment route reference resolves to multiple local Experiments");
  }
  const experiment = matches[0];
  return experiment
    ? loadLocalExperiment(input, environments, experiment, activeEnvironment.guarded)
    : resolveMissingExperiment(input, environments);
}

async function resolveMissingExperiment(
  input: ExperimentRouteInput,
  environments: ReturnType<typeof currentAppEnvironments>,
) {
  const runId = experimentRunId(input.pathname);
  const resolved = await resolveControlPanelExperimentEnvironment({
    data: {
      appId: input.scoped.scope.appId,
      targetEnvironmentId: input.scoped.scope.environmentId,
      environments,
      experimentRef: input.experimentRef,
      runId,
    },
  });
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error.message), { status: resolved.status });
  }
  if (resolved.data.kind !== "experiment") {
    throwResolvedNotFound(resolved.data, input.scoped.scope, input.href);
  }
  throw redirect({
    href: canonicalExperimentHref(
      input.scoped.scope,
      resolved.data.experimentKey,
      input.href,
      runId,
    ),
  });
}

async function loadLocalExperiment(
  input: ExperimentRouteInput,
  environments: ReturnType<typeof currentAppEnvironments>,
  experiment: { id: string; key: string },
  guarded: boolean,
) {
  const runId = experimentRunId(input.pathname);
  if (input.experimentRef !== experiment.key) {
    throw redirect({
      href: canonicalExperimentHref(input.scoped.scope, experiment.key, input.href, runId),
    });
  }
  const detail = await input.queryClient.ensureQueryData(
    experimentDetailQuery({
      appId: input.scoped.scope.appId,
      environmentId: input.scoped.scope.environmentId,
      experimentId: experiment.id,
    }),
  );
  if (runId && !detail.runs.some((run) => run.id === runId)) {
    const resolved = await resolveControlPanelExperimentEnvironment({
      data: {
        appId: input.scoped.scope.appId,
        targetEnvironmentId: input.scoped.scope.environmentId,
        environments,
        experimentRef: experiment.key,
        runId,
      },
    });
    if (!resolved.ok) {
      throw Object.assign(new Error(resolved.error.message), { status: resolved.status });
    }
    throwResolvedNotFound(resolved.data, input.scoped.scope, input.href);
  }
  return { experimentId: experiment.id, guarded };
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
  if (resolution.kind === "run_elsewhere") {
    if (resolution.env === scope.env) {
      throw new Error("Run resolution contradicts the loaded Experiment detail");
    }
    throw notFound({
      data: {
        kind: "run_elsewhere",
        env: scope.env,
        sourceEnv: resolution.env,
        href: canonicalExperimentHref(
          { ...scope, env: resolution.env },
          resolution.experimentKey,
          currentHref,
          resolution.runId,
        ),
      } satisfies ExperimentNotFoundData,
    });
  }
  if (resolution.kind === "run_not_found") {
    throw notFound({ data: { kind: "run", env: scope.env } satisfies ExperimentNotFoundData });
  }
  if (
    resolution.kind === "experiment_not_found" ||
    resolution.kind === "experiment_not_in_environment"
  ) {
    throw notFound({
      data: { kind: "experiment", env: scope.env } satisfies ExperimentNotFoundData,
    });
  }
  throw new Error("Experiment resolution returned an unexpected local Experiment");
}

function canonicalExperimentHref(
  scope: { orgSlug: string; appSlug: string; env: string },
  experimentKey: string,
  currentHref: string,
  runId?: string,
): string {
  const current = new URL(currentHref, "https://panel.splitch.dev");
  const tab = current.pathname.match(/\/(results|setup)\/?$/)?.[1];
  const experiment = `${scopedHref(scope)}/experiments/${encodeURIComponent(experimentKey)}`;
  const run = runId ? `${experiment}/runs/${encodeURIComponent(runId)}` : experiment;
  return `${run}${tab ? `/${tab}` : ""}${current.search}${current.hash}`;
}

function experimentRunId(pathname: string): string | undefined {
  const encoded = pathname.match(/\/runs\/([^/]+)/)?.[1];
  return encoded ? decodeURIComponent(encoded) : undefined;
}
