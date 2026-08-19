import { type ApiRouteContract, type RouteOwner, routesDelegatedBy } from "@splitch/contracts";
import { envScope, type Repository } from "@splitch/db";
import {
  delegatedIdentityFrom,
  delegatedRequest,
  type HandlerArgs,
  type Registrar,
  type RouteHandler,
  renderError,
} from "@splitch/worker-runtime";
import type { Hono } from "hono";
import {
  analysisResultsNoRunEnvelope,
  resolveExperimentResultsTarget,
} from "./analysis-results-request";
import { requireAppMember } from "./app-authz";
import { appNotFound } from "./app-environment-model";
import { experimentNotFound, runNotFound } from "./experiment-errors";
import { environmentExists } from "./experiment-handler-shared";
import { ORG_MEMBER_ROLES, requireOrgRole } from "./org-authz";
import { controlPlaneRoute } from "./routes";

/**
 * The routes `api.splitch.dev` answers for but does not execute (ADR-0046).
 *
 * These arrive holding a control-plane token, so the control plane is where they
 * are addressed; the Analysis and Evaluation Workers execute them. Mounting is
 * derived from the registry rather than listed here, so a delegated route added
 * to the registry gets a door without a second edit.
 *
 * The registrar has already run the whole guard chain by the time these handlers
 * run. What is left is the one check the generic chain cannot make, because it
 * needs the tenant tables: that the Environment in the path belongs to the App in
 * the path (see environmentScopeError). Nothing crosses the binding until it has
 * passed, because the owner Worker trusts what arrives over it.
 *
 * Experiment results additionally resolve Experiment existence and Run selection
 * here (SPL-305): Analysis only sees Tinybird, which cannot tell a draft
 * Experiment from a missing id.
 */
export type DelegationBindings = Partial<Record<RouteOwner, Fetcher>>;

export function mountDelegatedRoutes(
  app: Hono,
  registrar: Registrar,
  bindings: DelegationBindings,
  repo: Repository,
): void {
  for (const route of routesDelegatedBy("control-plane-api")) {
    registrar.mount(
      app,
      controlPlaneRoute(route.operationId),
      delegatingHandler(route, bindings[route.owner], repo),
    );
  }
}

/**
 * The guard chain binds the principal to `:appId`, but nothing binds `:appId` to
 * `:environmentId`: a control-plane token is legitimately Environment-unbound
 * (ADR-0027), so the co-scope step passes any Environment in the path. Every
 * other Environment-scoped control-plane handler closes that by reading the
 * Environment under the App's scope, and delegation must not be the one door
 * that skips it -- the owner Worker is downstream of this decision and only sees
 * an already-authorized request.
 */
async function environmentScopeError(
  repo: Repository,
  params: Record<string, string>,
  requestId: string,
): Promise<Response | null> {
  const { appId, environmentId } = params;
  if (appId === undefined || environmentId === undefined) return null;
  return (await environmentExists({ repo }, envScope(appId, environmentId)))
    ? null
    : appNotFound(requestId);
}

function delegatingHandler(
  route: ApiRouteContract,
  binding: Fetcher | undefined,
  repo: Repository,
): RouteHandler<unknown> {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const parts = inputParts(input);
    const scopeError = await delegationScopeError(
      route,
      repo,
      parts.params ?? {},
      principal,
      requestId,
    );
    if (scopeError) return scopeError;

    // Experiment results: D1 can finish the read without Analysis (draft →
    // no_run, missing → EXPERIMENT_NOT_FOUND). Run that gate before the binding
    // check so an unbound ANALYSIS_API cannot mask those as SERVICE_UNAVAILABLE
    // (SPL-305 / production outage class from 31d86f6a).
    const pinned = await pinExperimentResultsRun(route, repo, parts, requestId);
    if (pinned instanceof Response) return pinned;

    if (!binding) return missingOwnerBinding(route, requestId);

    return binding.fetch(
      delegatedRequest(route, delegatedIdentityFrom(route, principal, parts.params ?? {}), {
        ...parts,
        requestId,
      }),
    );
  };
}

async function delegationScopeError(
  route: ApiRouteContract,
  repo: Repository,
  params: Record<string, string>,
  principal: HandlerArgs<unknown>["principal"],
  requestId: string,
): Promise<Response | null> {
  return (
    (await exposureStatusMembershipError(route, repo, params, principal, requestId)) ??
    (await environmentScopeError(repo, params, requestId))
  );
}

/**
 * This durable onboarding read leaves D1 for Analysis, so a long-lived bearer
 * must not keep working after either live membership is removed. The signed
 * Panel resolver already performs these checks; repeating them here keeps the
 * public Control Plane route equally strict for every control-plane token.
 */
async function exposureStatusMembershipError(
  route: ApiRouteContract,
  repo: Repository,
  params: Record<string, string>,
  principal: HandlerArgs<unknown>["principal"],
  requestId: string,
): Promise<Response | null> {
  if (route.operationId !== "environment_exposure_status_get") return null;
  const appId = params.appId;
  if (!appId) return appNotFound(requestId);

  const appMembershipError = await requireAppMember({ repo }, appId, principal, requestId);
  if (appMembershipError) return appMembershipError;

  const app = await repo.identity.getApp(appId);
  if (!app) return appNotFound(requestId);
  return requireOrgRole({ repo }, app.organizationId, principal, ORG_MEMBER_ROLES, requestId);
}

function missingOwnerBinding(route: ApiRouteContract, requestId: string): Response {
  // A deployed control plane without the owner's binding cannot answer this
  // route at all. Saying so beats a 404 that reads as "no such operation" --
  // but this route is reachable through the MCP door (ADR-0046/SPL-313), and an
  // agent there cannot act on a binding it cannot see, and "analysis-api" is
  // exactly the internal vocabulary that door refuses to leak. The owner name
  // stays on the operator side: console.error, untruncated, next to the
  // operationId, for `wrangler tail`.
  console.error(
    `control-plane-api: ${route.operationId} is executed by ${route.owner}, whose service binding is not configured`,
  );
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: `${route.operationId} is temporarily unavailable`,
      details: { retryAfterMs: 30_000 },
    },
    { requestId },
  );
}

/**
 * For experiment results: resolve Experiment/Run in D1 and either return a
 * finished Response (draft / missing) or mutate `parts` to pin the Run id on
 * the hop. Other delegated routes pass through unchanged.
 */
async function pinExperimentResultsRun(
  route: ApiRouteContract,
  repo: Repository,
  parts: {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  },
  requestId: string,
): Promise<Response | undefined> {
  if (!isExperimentResultsRoute(route.operationId)) return undefined;

  const gated = await experimentResultsBeforeHop(repo, parts, requestId);
  if (gated.response) return gated.response;

  // Pin the resolved Run on the hop so Analysis never guesses from empty
  // Tinybird rows. GET carries runId in the query; POST in the body.
  if (route.method === "GET") {
    parts.query = { ...parts.query, runId: gated.runId };
  } else {
    parts.body = { ...(isRecord(parts.body) ? parts.body : {}), runId: gated.runId };
  }
  return undefined;
}

function isExperimentResultsRoute(
  operationId: string,
): operationId is "experiment_results_get" | "experiment_results_post" {
  return operationId === "experiment_results_get" || operationId === "experiment_results_post";
}

/**
 * Separate Experiment existence from Run existence before Analysis sees the
 * request. Returns a finished Response for draft / missing cases, or the Run
 * id to pin on the hop so Analysis never has to guess from empty Tinybird rows.
 */
async function experimentResultsBeforeHop(
  repo: Repository,
  parts: {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  },
  requestId: string,
): Promise<{ response: Response; runId?: undefined } | { response?: undefined; runId: string }> {
  const params = parts.params ?? {};
  const appId = params.appId;
  const environmentId = params.environmentId;
  const experimentId = params.experimentId;
  if (appId === undefined || environmentId === undefined || experimentId === undefined) {
    return { response: experimentNotFound(requestId) };
  }

  const requestedRunId = optionalRunId(parts);
  const resolved = await resolveExperimentResultsTarget(repo, {
    appId,
    environmentId,
    experimentId,
    ...(requestedRunId !== undefined ? { runId: requestedRunId } : {}),
  });

  switch (resolved.outcome) {
    case "experiment_not_found":
      return { response: experimentNotFound(requestId) };
    case "no_run":
      return { response: Response.json(analysisResultsNoRunEnvelope()) };
    case "run_not_found":
      return { response: runNotFound(requestId) };
    case "run":
      return { runId: resolved.runId };
  }
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

/**
 * The parsed input, read back as request pieces. Narrowing rather than casting:
 * the schema composes only the parts a route declares, so an absent `query` on a
 * params-only route is normal, not a fault.
 */
function inputParts(input: unknown): {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
} {
  if (typeof input !== "object" || input === null) return {};
  const source = input as Record<string, unknown>;
  return {
    ...(isRecord(source.params) ? { params: source.params as Record<string, string> } : {}),
    ...(isRecord(source.query) ? { query: source.query } : {}),
    ...("body" in source ? { body: source.body } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
