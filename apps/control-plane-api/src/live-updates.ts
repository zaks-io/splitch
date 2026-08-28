import type { ErrorResponse, ServerAuthenticatedLiveUpdateContext } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import {
  emptyError,
  renderError,
  type AuthResolver,
  type Principal,
  type RateLimiter,
} from "@splitch/worker-runtime";
import type { Context, Hono } from "hono";
import type { ConfigStoreAccess } from "./config-store-do";
import { resolveControlPlanePathSelectors } from "./path-selector-resolution";

const LIVE_UPDATE_PATH = "/apps/:appId/envs/:environmentId/live";
const REQUEST_ID_HEADER = "x-request-id";
const FAIL_CLOSED_RETRY_MS = 1000;

export interface LiveUpdateDeps {
  authResolver: AuthResolver;
  rateLimiter: RateLimiter;
  configStore?: ConfigStoreAccess;
  repo: Repository;
  defaultHeaders?: Record<string, string>;
}

export function mountLiveUpdateRoute(app: Hono, deps: LiveUpdateDeps): void {
  app.get(LIVE_UPDATE_PATH, (c) => handleLiveUpdate(c, deps));
}

async function handleLiveUpdate(c: Context, deps: LiveUpdateDeps): Promise<Response> {
  const request = c.req.raw;
  const requestId = requestIdFor(request);
  const requestedAppId = pathParam(c, "appId");
  const requestedEnvironmentId = pathParam(c, "environmentId");

  try {
    const auth = await deps.authResolver(request);
    if (!auth.ok) {
      return fail(
        auth.reason,
        auth.reason === "UNAUTHORIZED" ? "no valid credential" : "credential is revoked",
        requestId,
        deps,
      );
    }

    const rateLimited = await rateLimit(request, auth.principal, deps);
    if (rateLimited) {
      return renderError(rateLimited, { requestId, defaultHeaders: deps.defaultHeaders });
    }

    const resolved = await resolveControlPlanePathSelectors(deps.repo, {
      contract: { id: "live_updates" },
      input: { params: { appId: requestedAppId, environmentId: requestedEnvironmentId } },
      params: { appId: requestedAppId, environmentId: requestedEnvironmentId },
      principal: auth.principal,
      request,
    });
    if (!resolved.ok) {
      return renderError(resolved.error, { requestId, defaultHeaders: deps.defaultHeaders });
    }
    const appId = requiredResolvedParam(resolved.params, "appId");
    const environmentId = requiredResolvedParam(resolved.params, "environmentId");

    const scopeError = liveScopeError(resolved.principal, appId, environmentId);
    if (scopeError) {
      return renderError(scopeError, { requestId, defaultHeaders: deps.defaultHeaders });
    }

    const environment = await deps.repo.identity.getEnvironment(appScope(appId), environmentId);
    if (!environment) {
      return renderError(
        { code: "APP_NOT_FOUND", message: "app environment not found", details: {} },
        { requestId, defaultHeaders: deps.defaultHeaders },
      );
    }

    if (!deps.configStore) {
      return renderError(
        {
          code: "SERVICE_UNAVAILABLE",
          message: "config live updates are not configured",
          details: { retryAfterMs: 1000 },
        },
        { requestId, defaultHeaders: deps.defaultHeaders },
      );
    }

    return deps.configStore
      .liveUpdatesFor(appId, environmentId)
      .connect(serverAuthenticatedLiveUpdateRequest(resolved.principal, appId, environmentId));
  } catch {
    return renderError(emptyError("INTERNAL_SERVER_ERROR", "unhandled runtime fault"), {
      requestId,
      defaultHeaders: deps.defaultHeaders,
    });
  }
}

async function rateLimit(
  request: Request,
  principal: Principal,
  deps: LiveUpdateDeps,
): Promise<ErrorResponse | null> {
  try {
    const decision = await deps.rateLimiter({
      class: "control-plane-actor",
      request,
      principal,
    });
    return decision.limited
      ? {
          code: "RATE_LIMITED",
          message: "rate limit exceeded",
          details: { retryAfterMs: decision.retryAfterMs },
        }
      : null;
  } catch {
    return {
      code: "RATE_LIMITED",
      message: "rate limit exceeded",
      details: { retryAfterMs: FAIL_CLOSED_RETRY_MS },
    };
  }
}

function liveScopeError(
  principal: Principal,
  appId: string,
  environmentId: string,
): ErrorResponse | null {
  if (principal.appId !== appId) {
    return emptyError("FORBIDDEN", "credential is not scoped to this app");
  }
  if (principal.environmentId !== null && principal.environmentId !== environmentId) {
    return emptyError("FORBIDDEN", "credential is not scoped to this environment");
  }
  return null;
}

function fail(
  code: "UNAUTHORIZED" | "CREDENTIAL_REVOKED",
  message: string,
  requestId: string,
  deps: LiveUpdateDeps,
): Response {
  return renderError(emptyError(code, message), { requestId, defaultHeaders: deps.defaultHeaders });
}

function requestIdFor(request: Request): string {
  const incoming = request.headers.get(REQUEST_ID_HEADER);
  return incoming && incoming.length > 0 && incoming.length <= 200 ? incoming : crypto.randomUUID();
}

function pathParam(c: Context, key: string): string {
  const value = c.req.param(key);
  if (!value) {
    throw new Error(`control-plane-api: live update route missing path param "${key}"`);
  }
  return value;
}

function requiredResolvedParam(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (!value) {
    throw new Error(`control-plane-api: selector resolver omitted path param "${key}"`);
  }
  return value;
}

function serverAuthenticatedLiveUpdateRequest(
  principal: Principal,
  appId: string,
  environmentId: string,
): Request {
  const context: ServerAuthenticatedLiveUpdateContext = {
    version: 1,
    authentication: "control-plane",
    principalId: principal.id,
    appId,
    environmentId,
  };
  return new Request("https://live-update.internal/connect", {
    headers: {
      upgrade: "websocket",
      "x-splitch-live-update-context": JSON.stringify(context),
    },
  });
}
