import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { createApp } from "./app.js";
import { makeFixtureDeviceFlow, makeWorkOsDeviceFlow } from "./device-flow.js";
import type { AuthApiEnv } from "./env.js";
import { fetchJwks } from "./jwks.js";
import { makeJtiCache } from "./jti-cache.js";
import { makeFixtureOtp, makeIdempotencyStore } from "./otp.js";
import { makeRateLimiter } from "./rate-limit.js";
import { makeKvRevocationStore } from "./revocation.js";
import { makeTokenSigner } from "./token-exchange.js";
import { makeFixtureTurnstile } from "./turnstile.js";
import { makeFixtureWorkOs } from "./workos.js";

const service = "splitch-auth-api";

/**
 * MODULE-SCOPED fixture state, constructed ONCE per isolate (at module load), NOT
 * per request. The two-step Door B ceremony REQUIRES this: the OTP issued at
 * /claim initiate must still be live at the /claim verify request, the WorkOS
 * verified-email index must persist so Door A's user is visible to a later Door B
 * collision check, the rate ceiling must accumulate across requests, and Turnstile
 * single-use must hold across requests. Per-request construction would reset all of
 * it (empty index, lost OTP, reset ceiling) — defeating the controls.
 *
 * These persist across requests WITHIN an isolate; they are NOT shared across
 * isolates. Cross-isolate durability is the job of the REAL adapters (shared atomic
 * D1/KV/DO for OTP + idempotency, the WAF for the real global ceiling, WorkOS SDK,
 * Cloudflare Turnstile siteverify) — which swap in behind these same ports without
 * touching the door logic. The SAME WorkOS port + OTP fixture + rate limiter are
 * shared by register + claim so both doors see one user, one code, one ceiling.
 */
const workos = makeFixtureWorkOs();
const otp = makeFixtureOtp();
const turnstile = makeFixtureTurnstile();
const rateLimiter = makeRateLimiter();
const idempotency = makeIdempotencyStore();

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
    const consentBaseUrl = env.CONTROL_PLANE_ORIGIN ?? "http://localhost:8787";
    const now = () => Date.now();
    const deviceFlow = env.WORKOS_CLIENT_ID
      ? makeWorkOsDeviceFlow({
          clientId: env.WORKOS_CLIENT_ID,
          apiKey: env.WORKOS_API_KEY,
          baseUrl: env.WORKOS_API_BASE_URL,
        })
      : makeFixtureDeviceFlow();
    // The token signer is STATELESS (HMAC over env secrets), so deriving it per
    // request from the env-bound secrets is correct — it carries no cross-request
    // state, unlike the module-scoped fixtures above.
    const tokenSigner = makeTokenSigner({
      assertionSecret,
      accessSecret,
      issuer: origin,
      controlPlaneAudience,
    });

    const app = createApp({
      repo,
      accessSecret,
      controlPlaneAudience,
      now,
      tokenSigner,
      idJag: {
        repo,
        jtiCache: makeJtiCache(env.JTI_CACHE),
        workos,
        fetchJwks,
        authApiOrigin: origin,
      },
      register: { repo, turnstile, rateLimiter, workos, tokenSigner, now },
      claim: { repo, workos, otp, idempotency, tokenSigner, rateLimiter, consentBaseUrl, now },
      deviceFlow,
      revocations: makeKvRevocationStore(env.SESSION_STORE),
    });

    return app.fetch(request, env);
  },
} satisfies ExportedHandler<AuthApiEnv>;
