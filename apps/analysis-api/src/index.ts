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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
    const jwksUri = env.AUTH_JWKS_URI ?? `${controlPlaneAudience}/.well-known/jwks.json`;
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          fetchJwks: makeHttpJwksFetcher(jwksUri),
          controlPlaneAudience,
        }),
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
