import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { createApp } from "./app.js";
import { makeControlPlaneAuthResolver } from "./auth-resolver.js";
import { ConfigStoreDurableObject, durableConfigStoreAccess } from "./config-store-do.js";
import type { ControlPlaneApiEnv } from "./env.js";
import { makeHttpJwksFetcher, makeJwksVerifier } from "./jwks-verify.js";
import { makeSessionCacheMemberProfileResolver } from "./member-profile-cache.js";
import { rateLimiterForTarget } from "./rate-limit.js";
import { makeSessionStore } from "./session-store.js";

const service = "splitch-control-plane-api";

/**
 * Control Plane API Worker entry. Health is served directly; everything else
 * mounts through the worker-runtime registrar behind the control-plane-token
 * resolver. D1 access is ALWAYS through createRepository (the tenant-isolation
 * seam, ADR-0018); KV handles session validation plus credential hot-validation
 * write-through. The JWKS verifier is injected so the real WorkOS/auth-api JWKS
 * (HUMAN-SETUP S41) swaps in behind the same port without touching the resolver.
 */
export default {
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
    });

    return app.fetch(request, env);
  },

  scheduled(event, _env, ctx): void {
    ctx.waitUntil(Promise.resolve(console.log(`${service}: demo reaper ${event.cron}`)));
  },
} satisfies ExportedHandler<ControlPlaneApiEnv>;

export { ConfigStoreDurableObject };
