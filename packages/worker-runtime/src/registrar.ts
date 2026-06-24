import type { RouteContract } from "@splitch/contracts";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import type { RegistrarDeps } from "./deps.js";
import { parseInput } from "./parse-input.js";
import { type Principal, PUBLIC_PRINCIPAL } from "./principal.js";
import { checkIdempotency } from "./steps/idempotency.js";
import { resolvePrincipal } from "./steps/resolve-principal.js";
import { applyRateLimit } from "./steps/rate-limit-step.js";
import { enforceScopes } from "./steps/scopes.js";
import { emptyError, renderError } from "./respond.js";
import { resolveRequestId } from "./request-id.js";

/**
 * What a route handler receives: the validated input, the resolved principal, and
 * the request id. The handler returns a Response; the guard merges default
 * headers + request id onto it. Domain errors are the handler's to render
 * (through renderError), keeping one status table everywhere.
 */
export interface HandlerArgs<Input> {
  input: Input;
  principal: Principal;
  requestId: string;
  request: Request;
}

export type RouteHandler<Input> = (args: HandlerArgs<Input>) => Promise<Response> | Response;

export interface Registrar {
  mount<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
    app: Hono,
    contract: RouteContract<Input, Output>,
    handler: RouteHandler<z.infer<Input>>,
  ): void;
}

/**
 * Build a registrar bound to one Worker's adapters. `mount` wires a route
 * contract onto a Hono app behind the fixed guard chain. The guard order is
 * invariant across every mounted route (see docs/spec/platform/worker-runtime.md).
 */
export function createRegistrar(deps: RegistrarDeps): Registrar {
  return {
    mount(app, contract, handler) {
      assertResolvable(contract, deps);

      const method = contract.method.toLowerCase() as Lowercase<RouteContract["method"]>;
      app[method](contract.path, async (c: Context) => {
        return runGuard(c, contract, deps, handler);
      });
    },
  };
}

async function runGuard<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  c: Context,
  contract: RouteContract<Input, Output>,
  deps: RegistrarDeps,
  handler: RouteHandler<z.infer<Input>>,
): Promise<Response> {
  const request = c.req.raw;
  // Step 1: request id + observability context.
  const requestId = resolveRequestId(request);
  deps.observability?.onRequest?.({
    requestId,
    method: contract.method,
    path: contract.path,
  });

  const fail = (error: Parameters<typeof renderError>[0]) => {
    deps.observability?.onError?.({
      requestId,
      code: error.code,
      status: 0,
    });
    return renderError(error, { requestId, defaultHeaders: deps.defaultHeaders });
  };

  try {
    // Step 2: parse params/query/headers/body with the route's Zod schema.
    const parsed = await parseInput(contract.input, request, c.req.param());
    if (!parsed.ok) {
      return fail(parsed.error);
    }

    // Step 3: resolve the principal through the Worker-provided resolver.
    const principalResult = await resolvePrincipal(contract, deps, request);
    if (!principalResult.ok) {
      return fail(principalResult.error);
    }
    const principal = principalResult.principal;

    // Step 4: rate-limit class (before scopes; fails closed on missing/throwing binding).
    const rateLimited = await applyRateLimit(contract, deps, request, principal);
    if (rateLimited) {
      return fail(rateLimited);
    }

    // Step 5: scopes + app/environment co-scope.
    const scopeError = enforceScopes(contract, principal, c.req.param());
    if (scopeError) {
      return fail(scopeError);
    }

    // Step 6: idempotency header validation for mutating routes.
    const idempotencyError = checkIdempotency(contract, request);
    if (idempotencyError) {
      return fail(idempotencyError);
    }

    // Step 7: hand parsed input + principal to the route handler.
    const response = await handler({
      input: parsed.value,
      principal,
      requestId,
      request,
    });

    return withDefaults(response, requestId, deps.defaultHeaders);
  } catch (cause) {
    // Step 8 (fault path): any unexpected throw is a loud 500, never a leak.
    deps.observability?.onError?.({ requestId, code: "INTERNAL_SERVER_ERROR", status: 500 });
    void cause;
    return renderError(emptyError("INTERNAL_SERVER_ERROR", "unhandled runtime fault"), {
      requestId,
      defaultHeaders: deps.defaultHeaders,
    });
  }
}

/** Merge the request id + default headers onto a handler-produced success Response. */
function withDefaults(
  response: Response,
  requestId: string,
  defaultHeaders: Record<string, string> | undefined,
): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(defaultHeaders ?? {})) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  if (!headers.has("x-request-id")) {
    headers.set("x-request-id", requestId);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Boot-time assertion: a route whose auth kind has no resolver is a configuration
 * bug, not a runtime 401. Fail at mount, loudly, before any request arrives. The
 * `public` kind needs no resolver (it maps to PUBLIC_PRINCIPAL).
 */
function assertResolvable(contract: RouteContract, deps: RegistrarDeps): void {
  if (contract.auth === "public") {
    return;
  }
  if (!deps.authResolvers[contract.auth]) {
    throw new Error(
      `worker-runtime: route "${contract.id}" requires auth kind "${contract.auth}" but no resolver was provided`,
    );
  }
}

export { PUBLIC_PRINCIPAL };
