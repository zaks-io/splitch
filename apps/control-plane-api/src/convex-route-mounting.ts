import type { Repository } from "@splitch/db";
import type { Registrar, RouteHandler } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { type ConvexHandlerDeps, makeConvexHandlers } from "./convex-handlers";
import { controlPlaneRoute } from "./routes";

export function mountConvexRoutes(
  app: Hono,
  registrar: Registrar,
  repo: Repository,
  deps: Omit<ConvexHandlerDeps, "repo"> | undefined,
): void {
  const panelHandlers = makeConvexHandlers({ repo, now: deps?.now });
  // Operator reads and revokes never decrypt the webhook secret, so the Panel
  // routes stay available when the data-plane KEK is not configured.
  registrar.mount(
    app,
    controlPlaneRoute("convex_installations_list"),
    panelHandlers.panelList as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("convex_installations_revoke"),
    panelHandlers.panelRemove as RouteHandler<unknown>,
  );
  if (!deps) return;
  const handlers = makeConvexHandlers({ repo, ...deps });
  registrar.mount(
    app,
    controlPlaneRoute("convex_installations_create"),
    handlers.create as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("convex_installations_get"),
    handlers.get as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("convex_installations_delete"),
    handlers.remove as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("convex_secret_rotations_create"),
    handlers.rotate as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("convex_snapshot_get"),
    handlers.snapshot as RouteHandler<unknown>,
  );
}
