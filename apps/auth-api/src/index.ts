import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import { createApp } from "./app";
import { makeFixtureDeviceFlow, makeWorkOsDeviceFlow } from "./device-flow";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import type { AuthApiEnv } from "./env";
import { fetchJwks } from "./jwks";
import { makeJtiCache } from "./jti-cache";
import { makeFixtureOtp, makeIdempotencyStore } from "./otp";
import { makeRateLimiter } from "./rate-limit";
import { makeKvRevocationStore } from "./revocation";
import { makeTokenSigner } from "./token-exchange";
import { makeFixtureTurnstile } from "./turnstile";
import { makeFixtureWorkOs } from "./workos";
import type { SmokeClientCredentials } from "./oauth-routes";

const service = "splitch-auth-api";

const workos = makeFixtureWorkOs();
const otp = makeFixtureOtp();
const turnstile = makeFixtureTurnstile();
const rateLimiter = makeRateLimiter();
const idempotency = makeIdempotencyStore();

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const observability = createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("auth-api", ctx),
    );
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json(
        createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      );
    }

    const repo = createRepository(env.DB);
    const origin = env.AUTH_API_ORIGIN ?? url.origin;
    const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? "http://localhost:8787";
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
      deviceRefreshSessions: makeD1DeviceRefreshSessionStore(repo, {
        cache: env.SESSION_STORE,
        now,
      }),
      revocations: makeKvRevocationStore(env.SESSION_STORE),
      smokeClientCredentials: sharedPreviewSmokeClient(env),
    });

    observability.onRequest?.({
      requestId: request.headers.get("x-request-id") ?? "auth-request",
      method: request.method,
      path: url.pathname,
    });
    return app.fetch(request, env);
  },
} satisfies ExportedHandler<AuthApiEnv>;

export default wrapWorkerHandler(handler, { surface: "auth-api" });

function sharedPreviewSmokeClient(env: AuthApiEnv): SmokeClientCredentials | undefined {
  if (env.SPLITCH_PLATFORM_TARGET !== "shared-preview" || !env.SPLITCH_SMOKE_CLIENT_SECRET) {
    return undefined;
  }
  return {
    clientId: env.SPLITCH_SMOKE_CLIENT_ID ?? "splitch-shared-preview-smoke",
    clientSecret: env.SPLITCH_SMOKE_CLIENT_SECRET,
    userId: env.SPLITCH_SMOKE_USER_ID ?? "user_shared_preview_smoke",
    scopes: (env.SPLITCH_SMOKE_SCOPES ?? "app:smoke-auth-missing-app:member")
      .split(/\s+/)
      .filter(Boolean),
  };
}
