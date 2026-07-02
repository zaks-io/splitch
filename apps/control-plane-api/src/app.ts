import type { Repository } from "@splitch/db";
import {
  type AuthResolver,
  createRegistrar,
  type RateLimiter,
  type Registrar,
  type RegistrarDeps,
} from "@splitch/worker-runtime";
import { Hono } from "hono";
import type { ConfigStoreAccess } from "./config-store-do.js";
import { makeHandlers } from "./handlers.js";
import { mountLiveUpdateRoute } from "./live-updates.js";
import { controlPlaneRoute } from "./routes.js";

/**
 * Control Plane API Worker HTTP surface.
 *
 * Every management route mounts through the @splitch/worker-runtime registrar so
 * the fixed guard chain (parse → resolve principal → rate-limit → scopes +
 * App/Env co-scope → idempotency → handler) is identical across routes and never
 * hand-rolled per endpoint (worker-runtime.md). This module wires the
 * control-plane-token resolver under its AuthKind and mounts the routes; the
 * guard does the rest.
 *
 * Authorization for these App/Org reads is the token's App/Org co-scope binding:
 * the guard rejects a principal not bound to the path's App with FORBIDDEN BEFORE
 * the handler (and thus before any repository call). Role-gating via static
 * scopes (INSUFFICIENT_SCOPES) is the same generic guard step; the account
 * routes ship with `scopes: []` because App authorization is co-scope + D1
 * membership (ADR-0022), so the role gate is layered by the owning Worker as the
 * CRUD surface lands.
 */

export interface AppDeps {
  /** Resolver for the `control-plane-token` AuthKind (bearer-JWT). */
  authResolver: AuthResolver;
  rateLimiter: RateLimiter;
  repo: Repository;
  configStore?: ConfigStoreAccess;
  defaultHeaders?: Record<string, string>;
}

/** Build the registrar bound to this Worker's control-plane-token resolver. */
export function controlPlaneRegistrar(deps: AppDeps): Registrar {
  const registrarDeps: RegistrarDeps = {
    authResolvers: { "control-plane-token": deps.authResolver },
    rateLimiter: deps.rateLimiter,
    defaultHeaders: deps.defaultHeaders,
  };
  return createRegistrar(registrarDeps);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const handlers = makeHandlers({ repo: deps.repo, configStore: deps.configStore });
  const registrar = controlPlaneRegistrar(deps);

  mountLiveUpdateRoute(app, {
    authResolver: deps.authResolver,
    rateLimiter: deps.rateLimiter,
    repo: deps.repo,
    configStore: deps.configStore,
    defaultHeaders: deps.defaultHeaders,
  });

  registrar.mount(app, controlPlaneRoute("apps_get"), handlers.getApp);
  registrar.mount(app, controlPlaneRoute("organizations_get"), handlers.getOrg);
  registrar.mount(app, controlPlaneRoute("flag_config_get"), handlers.getFlagConfig);
  registrar.mount(app, controlPlaneRoute("flag_config_update"), handlers.updateFlagConfig);

  return app;
}
