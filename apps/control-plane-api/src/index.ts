import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import {
  createWorkerObservability,
  workerEmitter,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import { createApp } from "./app";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { ConfigStoreDurableObject, durableConfigStoreAccess } from "./config-store-do";
import type { ControlPlaneApiEnv } from "./env";
import { makeHttpJwksFetcher, makeJwksVerifier } from "./jwks-verify";
import { makeSessionCacheMemberProfileResolver } from "./member-profile-cache";
import { rateLimiterForTarget } from "./rate-limit";
import { makeSessionStore } from "./session-store";

const service = "splitch-control-plane-api";

const handler = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json(
        createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      );
    }

    const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
    const jwksUri = env.AUTH_JWKS_URI ?? `${controlPlaneAudience}/.well-known/jwks.json`;
    const verifier = makeJwksVerifier({
      fetchJwks: makeHttpJwksFetcher(jwksUri),
      controlPlaneAudience,
    });

    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier,
        sessions: makeSessionStore(env.SESSION_STORE),
      }),
      rateLimiter: rateLimiterForTarget(env.SPLITCH_PLATFORM_TARGET),
      repo: createRepository(env.DB),
      credentialStore: env.CREDENTIAL_STORE,
      configStore: durableConfigStoreAccess(env.CONFIG_STORE_WRITER),
      memberProfileResolver: makeSessionCacheMemberProfileResolver(env.SESSION_STORE),
      observability: createWorkerObservability(env, { surface: "control-plane-api" }),
    });

    return app.fetch(request, env);
  },

  scheduled(event, env, ctx): void {
    ctx.waitUntil(runDemoReaper(env, event));
  },
} satisfies ExportedHandler<ControlPlaneApiEnv>;

export default wrapWorkerHandler(handler, { surface: "control-plane-api" });

async function runDemoReaper(env: ControlPlaneApiEnv, event: ScheduledController): Promise<void> {
  const result = await createRepository(env.DB).identity.reapExpiredProvisionalOrganizations(
    new Date(event.scheduledTime).toISOString(),
  );
  workerEmitter(env, { surface: "control-plane-api" }).log("info", "demo-reaper", {
    service,
    job: "demo-reaper",
    cron: event.cron,
    candidates: result.candidates,
    reaped: result.reaped,
  });
}

export { ConfigStoreDurableObject };
