import type { Repository } from "@splitch/db";
import type { Registrar, RouteHandler } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import type { CloudflareHandlerDeps } from "./cloudflare-handlers";
import { mountCloudflareRoutes } from "./cloudflare-route-mounting";
import type { ConvexHandlerDeps } from "./convex-handlers";
import { mountConvexRoutes } from "./convex-route-mounting";
import {
  type IntegrationDeliveryAccess,
  makeIntegrationDeliveryHandler,
} from "./integration-delivery-handler";
import { controlPlaneRoute } from "./routes";
import type { SentryHandlerDeps } from "./sentry-handlers";
import { mountSentryRoutes } from "./sentry-route-mounting";

export interface IntegrationRouteDeps {
  door?: "public" | "binding";
  repo: Repository;
  integrationDelivery?: IntegrationDeliveryAccess;
  convex?: Omit<ConvexHandlerDeps, "repo">;
  cloudflare?: Omit<CloudflareHandlerDeps, "repo">;
  sentry?: Omit<SentryHandlerDeps, "repo">;
}

export function mountIntegrationRoutes(
  app: Hono,
  registrar: Registrar,
  deps: IntegrationRouteDeps,
) {
  registrar.mount(
    app,
    controlPlaneRoute("integration_deliveries_create"),
    makeIntegrationDeliveryHandler({
      repo: deps.repo,
      delivery: deps.integrationDelivery,
    }) as RouteHandler<unknown>,
  );
  mountConvexRoutes(app, registrar, deps.repo, deps.door === "binding" ? deps.convex : undefined);
  mountCloudflareRoutes(
    app,
    registrar,
    deps.repo,
    deps.door === "binding" ? deps.cloudflare : undefined,
  );
  mountSentryRoutes(app, registrar, deps.repo, deps.sentry ?? {});
}
