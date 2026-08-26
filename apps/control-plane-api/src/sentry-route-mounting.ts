import type { Repository } from "@splitch/db";
import type { Registrar, RouteHandler } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { controlPlaneRoute } from "./routes";
import { makeSentryHandlers, type SentryHandlerDeps } from "./sentry-handlers";

/**
 * Mounted unconditionally, unlike the Convex and Cloudflare integrations: these
 * are operator routes on the same door as API Keys, and reads do not touch the
 * KEK at all. A missing KEK throws inside `encryptIntegrationSecret` on the two
 * routes that seal a secret, which is louder than a route that quietly 404s.
 */
export function mountSentryRoutes(
  app: Hono,
  registrar: Registrar,
  repo: Repository,
  deps: Omit<SentryHandlerDeps, "repo">,
): void {
  const handlers = makeSentryHandlers({ repo, ...deps });
  const mount = (operationId: Parameters<typeof controlPlaneRoute>[0], handler: unknown) => {
    registrar.mount(app, controlPlaneRoute(operationId), handler as RouteHandler<unknown>);
  };
  mount("sentry_installations_list", handlers.list);
  mount("sentry_installations_create", handlers.create);
  mount("sentry_installations_get", handlers.get);
  mount("sentry_installations_delete", handlers.remove);
  mount("sentry_secret_rotations_create", handlers.rotate);
}
