import type { Repository } from "@splitch/db";
import type { Registrar, RouteHandler } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { controlPlaneRoute } from "./routes";
import { makeSentryHandlers, type SentryHandlerDeps } from "./sentry-handlers";

export function mountSentryRoutes(
  app: Hono,
  registrar: Registrar,
  repo: Repository,
  deps: Omit<SentryHandlerDeps, "repo"> | undefined,
): void {
  if (!deps) return;
  const handlers = makeSentryHandlers({ repo, ...deps });
  registrar.mount(
    app,
    controlPlaneRoute("sentry_installations_create"),
    handlers.create as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("sentry_installations_get"),
    handlers.get as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("sentry_installations_delete"),
    handlers.remove as RouteHandler<unknown>,
  );
  registrar.mount(
    app,
    controlPlaneRoute("sentry_secret_rotations_create"),
    handlers.rotate as RouteHandler<unknown>,
  );
}
