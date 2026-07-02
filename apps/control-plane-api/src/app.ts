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
import { makeCredentialHandlers } from "./credential-handlers.js";
import { makeHandlers } from "./handlers.js";
import { mountLiveUpdateRoute } from "./live-updates.js";
import type { MemberProfileResolver } from "./org-handlers.js";
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
 * Authorization for App reads is the token's App co-scope binding: the guard
 * rejects a principal not bound to the path's App with FORBIDDEN BEFORE the
 * handler (and thus before any repository call). Org routes layer live D1
 * membership checks in their owning handler module (ADR-0022).
 */

export interface AppDeps {
  /** Resolver for the `control-plane-token` AuthKind (bearer-JWT). */
  authResolver: AuthResolver;
  rateLimiter: RateLimiter;
  repo: Repository;
  credentialStore?: KVNamespace;
  configStore?: ConfigStoreAccess;
  memberProfileResolver?: MemberProfileResolver;
  nowIso?: () => string;
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
  const handlers = makeHandlers({
    repo: deps.repo,
    configStore: deps.configStore,
    memberProfileResolver: deps.memberProfileResolver,
    nowIso: deps.nowIso,
  });
  const credentialHandlers = makeCredentialHandlers({
    repo: deps.repo,
    credentialStore: deps.credentialStore,
    nowIso: deps.nowIso,
  });
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
  registrar.mount(app, controlPlaneRoute("organizations_update"), handlers.updateOrg);
  registrar.mount(app, controlPlaneRoute("organization_members_list"), handlers.listMembers);
  registrar.mount(app, controlPlaneRoute("organization_members_add"), handlers.addMember);
  registrar.mount(app, controlPlaneRoute("organization_members_update"), handlers.updateMember);
  registrar.mount(app, controlPlaneRoute("organization_members_remove"), handlers.removeMember);
  registrar.mount(app, controlPlaneRoute("flag_config_get"), handlers.getFlagConfig);
  registrar.mount(app, controlPlaneRoute("flag_config_update"), handlers.updateFlagConfig);
  registrar.mount(app, controlPlaneRoute("client_key_get"), credentialHandlers.getClientKey);
  registrar.mount(app, controlPlaneRoute("client_key_update"), credentialHandlers.updateClientKey);
  registrar.mount(app, controlPlaneRoute("client_key_rotate"), credentialHandlers.rotateClientKey);
  registrar.mount(app, controlPlaneRoute("api_keys_list"), credentialHandlers.listApiKeys);
  registrar.mount(app, controlPlaneRoute("api_keys_create"), credentialHandlers.createApiKey);
  registrar.mount(app, controlPlaneRoute("api_keys_revoke"), credentialHandlers.revokeApiKey);

  return app;
}
