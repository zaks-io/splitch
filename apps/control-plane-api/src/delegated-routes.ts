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
import { requireAppMember } from "./app-authz";
import { appNotFound } from "./app-environment-model";
import type { ConfigStoreAccess } from "./config-store-access";
import { handleExperimentResultsDelegation } from "./experiment-results-delegated";
import { environmentExists } from "./experiment-handler-shared";
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
 * here (SPL-305), then enrich the Analysis envelope through the shared result
 * producer (plan 0.15) before the response leaves.
 */
export type DelegationBindings = Partial<Record<RouteOwner, Fetcher>>;

export function mountDelegatedRoutes(
  app: Hono,
  registrar: Registrar,
  bindings: DelegationBindings,
  repo: Repository,
  configStore?: ConfigStoreAccess,
): void {
  for (const route of routesDelegatedBy("control-plane-api")) {
    registrar.mount(
      app,
      controlPlaneRoute(route.operationId),
      delegatingHandler(route, bindings[route.owner], repo, configStore),
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
  configStore?: ConfigStoreAccess,
): RouteHandler<unknown> {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const parts = inputParts(input);
    const refused = await refuseBeforeDelegation(
      route,
      repo,
      configStore,
      principal,
      parts,
      requestId,
    );
    if (refused) return refused;

    if (isExperimentResultsRoute(route.operationId)) {
      return experimentResultsResponse(
        route.operationId,
        route,
        binding,
        repo,
        principal,
        requestId,
        parts,
      );
    }
    if (!binding) return missingOwnerBinding(route, requestId);
    return binding.fetch(
      delegatedRequest(route, delegatedIdentityFrom(route, principal, parts.params ?? {}), {
        ...parts,
        requestId,
      }),
    );
  };
}

async function refuseBeforeDelegation(
  route: ApiRouteContract,
  repo: Repository,
  configStore: ConfigStoreAccess | undefined,
  principal: HandlerArgs<unknown>["principal"],
  parts: ReturnType<typeof inputParts>,
  requestId: string,
): Promise<Response | null> {
  return (
    (await analysisTrafficError(route, parts.params?.appId, configStore, requestId)) ??
    (await delegationScopeError(route, repo, parts.params ?? {}, principal, requestId))
  );
}

async function experimentResultsResponse(
  operationId: "experiment_results_get" | "experiment_results_post",
  route: ApiRouteContract,
  binding: Fetcher | undefined,
  repo: Repository,
  principal: HandlerArgs<unknown>["principal"],
  requestId: string,
  parts: ReturnType<typeof inputParts>,
): Promise<Response> {
  const result = await handleExperimentResultsDelegation({
    repo,
    binding,
    principal,
    requestId,
    operationId,
    parts,
  });
  if (result.kind === "needs_binding") return missingOwnerBinding(route, requestId);
  return result.response;
}

async function analysisTrafficError(
  route: ApiRouteContract,
  appId: string | undefined,
  configStore: ConfigStoreAccess | undefined,
  requestId: string,
): Promise<Response | null> {
  if (route.owner !== "analysis-api" || !appId || !configStore?.assertAppIdentityTrafficAllowed) {
    return null;
  }
  try {
    await configStore.assertAppIdentityTrafficAllowed(appId);
    return null;
  } catch {
    return renderError(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "App identity reset is in progress",
        details: { retryAfterMs: 30_000 },
      },
      { requestId },
    );
  }
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
  const orgMembership = await repo.identity.getOrgMembership(app.organizationId, principal.id);
  return orgMembership ? null : exposureStatusOrgMembershipForbidden(requestId);
}

function exposureStatusOrgMembershipForbidden(requestId: string): Response {
  return renderError(
    {
      code: "FORBIDDEN",
      message: "credential owner is no longer a member of this App's organization",
      details: {},
    },
    { requestId },
  );
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

function isExperimentResultsRoute(
  operationId: string,
): operationId is "experiment_results_get" | "experiment_results_post" {
  return operationId === "experiment_results_get" || operationId === "experiment_results_post";
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
