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
