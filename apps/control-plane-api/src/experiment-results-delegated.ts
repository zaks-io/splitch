import type { ExperimentResultsView } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import {
  delegatedIdentityFrom,
  delegatedRequest,
  type HandlerArgs,
  type Principal,
} from "@splitch/worker-runtime";
import { resolveExperimentResultsTarget } from "./analysis-results-request";
import { experimentNotFound, runNotFound } from "./experiment-errors";
import {
  analysisHopParts,
  canConcludeWithRole,
  enrichAnalysisResultsResponse,
  loadResultsRun,
  produceNoRunResults,
  resultsViewFromParts,
} from "./experiment-results-enrich";
import { controlPlaneRoute } from "./routes";

/**
 * Control Plane door for experiment_results_*: resolve the Run in D1, hop to
 * Analysis for the raw envelope, then run the shared result producer so CLI,
 * MCP, and the panel all see readiness before statistics.
 *
 * Draft / missing cases finish without the Analysis binding so an unbound
 * ANALYSIS_API cannot mask them as SERVICE_UNAVAILABLE (SPL-305).
 */

export type ExperimentResultsDelegationResult =
  | { kind: "response"; response: Response }
  | { kind: "needs_binding" };

interface ResultsPathScope {
  appId: string;
  environmentId: string;
  experimentId: string;
}

export async function handleExperimentResultsDelegation(args: {
  repo: Repository;
  binding: Fetcher | undefined;
  principal: Principal;
  requestId: string;
  operationId: "experiment_results_get" | "experiment_results_post";
  parts: {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  };
}): Promise<ExperimentResultsDelegationResult> {
  const scope = resultsPathScope(args.parts.params ?? {}, args.requestId);
  if ("response" in scope) return { kind: "response", response: scope.response };

  const view = resultsViewFromParts(args.parts);
  const preHop = await resolveBeforeAnalysis(
    args.repo,
    scope,
    optionalRunId(args.parts),
    view,
    args.requestId,
  );
  if (preHop.kind !== "run") return preHop;
  if (!args.binding) return { kind: "needs_binding" };

  return hopAndEnrich({
    ...args,
    binding: args.binding,
    scope,
    runId: preHop.runId,
    view,
  });
}

async function resolveBeforeAnalysis(
  repo: Repository,
  scope: ResultsPathScope,
  requestedRunId: string | undefined,
  view: ExperimentResultsView,
  requestId: string,
): Promise<ExperimentResultsDelegationResult | { kind: "run"; runId: string }> {
  const resolved = await resolveExperimentResultsTarget(repo, {
    ...scope,
    ...(requestedRunId !== undefined ? { runId: requestedRunId } : {}),
  });
  if (resolved.outcome === "experiment_not_found") {
    return { kind: "response", response: experimentNotFound(requestId) };
  }
  if (resolved.outcome === "no_run") {
    return { kind: "response", response: Response.json(produceNoRunResults(view)) };
  }
  if (resolved.outcome === "run_not_found") {
    return { kind: "response", response: runNotFound(requestId) };
  }
  return { kind: "run", runId: resolved.runId };
}

async function hopAndEnrich(args: {
  repo: Repository;
  binding: Fetcher;
  principal: Principal;
  requestId: string;
  operationId: "experiment_results_get" | "experiment_results_post";
  parts: {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  };
  scope: ResultsPathScope;
  runId: string;
  view: ExperimentResultsView;
}): Promise<ExperimentResultsDelegationResult> {
  const run = await loadResultsRun(args.repo, {
    appId: args.scope.appId,
    environmentId: args.scope.environmentId,
    runId: args.runId,
  });
  if (!run || run.experimentId !== args.scope.experimentId) {
    return { kind: "response", response: runNotFound(args.requestId) };
  }

  const route = controlPlaneRoute(args.operationId);
  const pinned = pinRunId(args.parts, route.method, run.id);
  const analysisResponse = await args.binding.fetch(
    delegatedRequest(route, delegatedIdentityFrom(route, args.principal, args.parts.params ?? {}), {
      ...analysisHopParts(pinned),
      requestId: args.requestId,
    }),
  );
  if (!analysisResponse.ok) {
    return { kind: "response", response: analysisResponse };
  }

  const canConclude = await actorCanConclude(args.repo, args.scope.appId, args.principal);
  return {
    kind: "response",
    response: Response.json(
      enrichAnalysisResultsResponse(await analysisResponse.json(), run, {
        view: args.view,
        canConclude,
      }),
    ),
  };
}

function resultsPathScope(
  params: Record<string, string>,
  requestId: string,
): ResultsPathScope | { response: Response } {
  const { appId, environmentId, experimentId } = params;
  if (appId === undefined || environmentId === undefined || experimentId === undefined) {
    return { response: experimentNotFound(requestId) };
  }
  return { appId, environmentId, experimentId };
}

function pinRunId(
  parts: {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  },
  method: string,
  runId: string,
) {
  if (method === "GET") {
    return { ...parts, query: { ...parts.query, runId } };
  }
  return {
    ...parts,
    body: { ...(isRecord(parts.body) ? parts.body : {}), runId },
  };
}

async function actorCanConclude(
  repo: Repository,
  appId: string,
  principal: Pick<HandlerArgs<unknown>["principal"], "id">,
): Promise<boolean> {
  const membership = await repo.identity.getAppMembership(appScope(appId), principal.id);
  return canConcludeWithRole(membership?.role);
}

function optionalRunId(parts: {
  query?: Record<string, unknown>;
  body?: unknown;
}): string | undefined {
  const fromQuery = parts.query?.runId;
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;
  if (isRecord(parts.body) && typeof parts.body.runId === "string" && parts.body.runId.length > 0) {
    return parts.body.runId;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
