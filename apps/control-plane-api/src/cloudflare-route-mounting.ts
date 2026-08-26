import type { Repository } from "@splitch/db";
import type { Registrar, RouteHandler } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { type CloudflareHandlerDeps, makeCloudflareHandlers } from "./cloudflare-handlers";
import { controlPlaneRoute } from "./routes";

export function mountCloudflareRoutes(
  app: Hono,
  registrar: Registrar,
  repo: Repository,
  deps: Omit<CloudflareHandlerDeps, "repo"> | undefined,
): void {
  const panelHandlers = makeCloudflareHandlers({ repo, now: deps?.now });
  // Operator reads and revokes never decrypt the push secret, so the Panel
  // routes stay available when the data-plane KEK is not configured.
  registrar.mount(
    app,
    controlPlaneRoute("cloudflare_installations_list"),
    panelHandlers.panelList as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("cloudflare_installations_revoke"),
    panelHandlers.panelRemove as RouteHandler<unknown>,
  );
  if (!deps) return;
  const handlers = makeCloudflareHandlers({ repo, ...deps });
  registrar.mount(
    app,
    controlPlaneRoute("cloudflare_installations_create"),
    handlers.create as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("cloudflare_installations_get"),
    handlers.get as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("cloudflare_installations_delete"),
    handlers.remove as RouteHandler<unknown>,
  );
}
