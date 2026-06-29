import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { createApp } from "./app.js";
import { makeControlPlaneAuthResolver } from "./auth-resolver.js";
import type { ControlPlaneApiEnv } from "./env.js";
import { makeHttpJwksFetcher, makeJwksVerifier } from "./jwks-verify.js";
import { failClosedRateLimiter } from "./rate-limit.js";
import { makeSessionStore } from "./session-store.js";

const service = "splitch-control-plane-api";

/**
 * Control Plane API Worker entry. Health is served directly; everything else
 * mounts through the worker-runtime registrar behind the control-plane-token
 * resolver. D1 access is ALWAYS through createRepository (the tenant-isolation
 * seam, ADR-0018); KV is the session-validation hot read. The JWKS verifier is
 * injected so the real WorkOS/auth-api JWKS (HUMAN-SETUP S41) swaps in behind the
 * same port without touching the resolver.
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
      rateLimiter: failClosedRateLimiter,
      repo: createRepository(env.DB),
    });

    return app.fetch(request, env);
  },

  scheduled(event, _env, ctx): void {
    ctx.waitUntil(Promise.resolve(console.log(`${service}: demo reaper ${event.cron}`)));
  },
} satisfies ExportedHandler<ControlPlaneApiEnv>;
