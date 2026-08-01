import { type ApiRouteContract, type RouteOwner, routesDelegatedBy } from "@splitch/contracts";
import {
  delegatedIdentityFrom,
  delegatedRequest,
  type HandlerArgs,
  type Registrar,
  renderError,
  type RouteHandler,
} from "@splitch/worker-runtime";
import type { Hono } from "hono";
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
 * run: delegation forwards an authorized request, it never makes an
 * authorization decision.
 */
export type DelegationBindings = Partial<Record<RouteOwner, Fetcher>>;

export function mountDelegatedRoutes(
  app: Hono,
  registrar: Registrar,
  bindings: DelegationBindings,
): void {
  for (const route of routesDelegatedBy("control-plane-api")) {
    registrar.mount(
      app,
      controlPlaneRoute(route.operationId),
      delegatingHandler(route, bindings[route.owner]),
    );
  }
}

function delegatingHandler(
  route: ApiRouteContract,
  binding: Fetcher | undefined,
): RouteHandler<unknown> {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    if (!binding) {
      // A deployed control plane without the owner's binding cannot answer this
      // route at all. Saying so beats a 404 that reads as "no such operation".
      return renderError(
        {
          code: "SERVICE_UNAVAILABLE",
          message: `${route.operationId} is executed by ${route.owner}, whose service binding is not configured`,
          details: { retryAfterMs: 30_000 },
        },
        { requestId },
      );
    }
    const parts = inputParts(input);
    return binding.fetch(
      delegatedRequest(route, delegatedIdentityFrom(route, principal, parts.params ?? {}), {
        ...parts,
        requestId,
      }),
    );
  };
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
