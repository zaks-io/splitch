import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import type { RateLimiter } from "@splitch/worker-runtime";
import { createApp } from "./app.js";
import {
  makeControlPlaneAuthResolver,
  makeHttpJwksFetcher,
  makeJwksVerifier,
  makeSessionStore,
} from "./auth.js";
import type { AnalysisApiEnv } from "./env.js";
import { runScheduledSnapshot } from "./scheduled.js";
import { createTinybirdCopyTransport, createTinybirdReadTransport } from "./tinybird.js";

const allowLimiter: RateLimiter = () => ({ limited: false });
const verifierCache = new Map<string, ReturnType<typeof makeJwksVerifier>>();
const service = "splitch-analysis-api";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json(
        createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      );
    }

    const controlPlaneAudience = requiredConfig(env.CONTROL_PLANE_ORIGIN, "CONTROL_PLANE_ORIGIN");
    const jwksUri = requiredConfig(env.AUTH_JWKS_URI, "AUTH_JWKS_URI");
    const expectedIssuer = requiredConfig(env.AUTH_API_ORIGIN, "AUTH_API_ORIGIN");
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: verifierFor({ jwksUri, controlPlaneAudience, expectedIssuer }),
        sessions: makeSessionStore(env.SESSION_STORE),
      }),
      rateLimiter: allowLimiter,
      tinybird: createTinybirdReadTransport(env),
      platformTarget: env.SPLITCH_PLATFORM_TARGET,
    });
    return app.fetch(request, env);
  },

  scheduled(event, env, ctx): void {
    ctx.waitUntil(
      runScheduledSnapshot({
        cron: event.cron,
        logger: console,
        scheduledTimeMs: event.scheduledTime,
        tinybird: createTinybirdCopyTransport(env),
      }),
    );
  },
} satisfies ExportedHandler<AnalysisApiEnv>;

function requiredConfig(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`analysis-api: ${name} config is required`);
  }
  return value;
}

function verifierFor(input: {
  jwksUri: string;
  controlPlaneAudience: string;
  expectedIssuer: string;
}): ReturnType<typeof makeJwksVerifier> {
  const cacheKey = JSON.stringify(input);
  const cached = verifierCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const verifier = makeJwksVerifier({
    fetchJwks: makeHttpJwksFetcher(input.jwksUri),
    controlPlaneAudience: input.controlPlaneAudience,
    expectedIssuer: input.expectedIssuer,
  });
  verifierCache.set(cacheKey, verifier);
  return verifier;
}
