import { type ApiRouteContract, type RouteOwner, routesDelegatedBy } from "@splitch/contracts";
import {
  delegatedIdentityFrom,
  delegatedRequest,
  type HandlerArgs,
  type Registrar,
  renderError,
} from "@splitch/worker-runtime";
import type { Hono } from "hono";

interface DelegationFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export type DelegationBindings = Partial<Record<RouteOwner, DelegationFetcher>>;

export function mountDelegatedRoutes(
  app: Hono,
  registrar: Registrar,
  bindings: DelegationBindings,
): void {
  for (const route of routesDelegatedBy("evaluation-api")) {
    registrar.mount(app, route, delegatingHandler(route, bindings[route.owner]));
  }
}

function delegatingHandler(route: ApiRouteContract, binding: DelegationFetcher | undefined) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    if (!binding) {
      return renderError(
        {
          code: "SERVICE_UNAVAILABLE",
          message: "The requested operation is temporarily unavailable",
          details: { retryAfterMs: 30_000 },
        },
        { requestId },
      );
    }

    return binding.fetch(
      delegatedRequest(route, delegatedIdentityFrom(route, principal, {}), {
        body: inputBody(input),
        requestId,
      }),
    );
  };
}

function inputBody(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("body" in input)) return undefined;
  return (input as { body: unknown }).body;
}
