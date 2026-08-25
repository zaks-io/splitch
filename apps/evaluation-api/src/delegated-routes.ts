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

    const parts = inputParts(input);
    return binding.fetch(
      delegatedRequest(route, delegatedIdentityFrom(route, principal, parts.params ?? {}), {
        ...parts,
        requestId,
      }),
    );
  };
}

function inputParts(input: unknown): {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
} {
  if (!isRecord(input)) return {};
  return {
    ...(isRecord(input.params) ? { params: input.params as Record<string, string> } : {}),
    ...(isRecord(input.query) ? { query: input.query } : {}),
    ...("body" in input ? { body: input.body } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
