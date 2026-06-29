import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { createApp } from "./app.js";
import type { AuthApiEnv } from "./env.js";
import { fetchJwks } from "./jwks.js";
import { makeJtiCache } from "./jti-cache.js";
import { makeTokenSigner } from "./token-exchange.js";
import { makeFixtureWorkOs } from "./workos.js";

const service = "splitch-auth-api";

/**
 * Auth API Worker entry. Builds the door app from real Cloudflare bindings and
 * mounts a health check. D1 access is ALWAYS through createRepository (the
 * tenant-isolation seam) — no raw client; KV is the jti replay cache. The local
 * fixture WorkOS port + HMAC token signer stand in until the real adapters land.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json(
        createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      );
    }

    const repo = createRepository(env.DB);
    const origin = env.AUTH_API_ORIGIN ?? url.origin;
    const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? "http://localhost:8787";
    // Two distinct secrets: assertion vs access token cannot cross-verify.
    const assertionSecret = env.ASSERTION_SIGNING_SECRET ?? "local-dev-assertion-secret";
    const accessSecret = env.ACCESS_TOKEN_SECRET ?? "local-dev-access-secret";
    const app = createApp({
      repo,
      accessSecret,
      controlPlaneAudience,
      now: () => Date.now(),
      idJag: {
        repo,
        jtiCache: makeJtiCache(env.JTI_CACHE),
        workos: makeFixtureWorkOs(),
        fetchJwks,
        authApiOrigin: origin,
      },
      tokenSigner: makeTokenSigner({
        assertionSecret,
        accessSecret,
        issuer: origin,
        controlPlaneAudience,
      }),
    });

    return app.fetch(request, env);
  },
} satisfies ExportedHandler<AuthApiEnv>;
