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
import { createTinybirdReadTransport } from "./tinybird.js";

const allowLimiter: RateLimiter = () => ({ limited: false });
const verifierCache = new Map<string, ReturnType<typeof makeJwksVerifier>>();

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
    const jwksUri = env.AUTH_JWKS_URI ?? `${controlPlaneAudience}/.well-known/jwks.json`;
    const expectedIssuer = env.AUTH_API_ORIGIN ?? new URL(jwksUri).origin;
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
        env,
        logger: console,
        tinybird: createTinybirdReadTransport(env),
      }),
    );
  },
} satisfies ExportedHandler<AnalysisApiEnv>;

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
