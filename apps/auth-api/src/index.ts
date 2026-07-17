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
import { makeFixtureTurnstile, makeRuntimeTurnstile } from "./turnstile";
import { makeFixtureWorkOs, makeHostedWorkOs } from "./workos";
import { makeWorkOsAccessTokenVerifier } from "./workos-access-token";
import type { SmokeClientCredentials } from "./oauth-routes";

const service = "splitch-auth-api";

const fixtureWorkos = makeFixtureWorkOs();
const otp = makeFixtureOtp();
const fixtureTurnstile = makeFixtureTurnstile();
const rateLimiter = makeRateLimiter();
const idempotency = makeIdempotencyStore();

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const observability = createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("auth-api", ctx),
    );
    if (!hostedWorkOsConfigured(env) || !hostedClaimConfigured(env)) {
      return Response.json(
        { error: "server_error", error_description: "hosted auth configuration is incomplete" },
        { status: 500 },
      );
    }
    const turnstile = makeRuntimeTurnstile({
      fixture: fixtureTurnstile,
      platformTarget: env.SPLITCH_PLATFORM_TARGET,
      secret: env.TURNSTILE_SECRET,
    });
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
    const consentBaseUrl = env.CONTROL_PANEL_ORIGIN ?? "http://localhost:8787";
    const now = () => Date.now();
    const workos = hostedWorkOs(env);
    const deviceFlow = makeDeviceFlow(env);
    const tokenSigner = makeTokenSigner({
      assertionSecret,
      accessSecret,
      accessTokenTrustContract: accessTokenTrustContract(env.SPLITCH_PLATFORM_TARGET),
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
      workosAccessTokens: workosAccessTokenVerifier(env),
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

function hostedWorkOs(env: AuthApiEnv) {
  if (!isHostedTarget(env.SPLITCH_PLATFORM_TARGET)) {
    return fixtureWorkos;
  }
  if (!env.WORKOS_API_KEY) {
    throw new Error("WORKOS_API_KEY is required for hosted targets");
  }
  return makeHostedWorkOs({ apiKey: env.WORKOS_API_KEY, baseUrl: env.WORKOS_API_BASE_URL });
}

function makeDeviceFlow(env: AuthApiEnv) {
  if (!isHostedTarget(env.SPLITCH_PLATFORM_TARGET) && !env.WORKOS_CLIENT_ID) {
    return makeFixtureDeviceFlow();
  }
  return makeWorkOsDeviceFlow({
    clientId: env.WORKOS_CLIENT_ID as string,
    apiKey: env.WORKOS_API_KEY,
    baseUrl: env.WORKOS_API_BASE_URL,
  });
}

function isHostedTarget(target: string | undefined): boolean {
  return target === "shared-preview" || target === "production";
}

function hostedWorkOsConfigured(env: AuthApiEnv): boolean {
  return (
    !isHostedTarget(env.SPLITCH_PLATFORM_TARGET) ||
    (Boolean(env.WORKOS_API_KEY) && Boolean(env.WORKOS_CLIENT_ID))
  );
}

function hostedClaimConfigured(env: AuthApiEnv): boolean {
  if (!isHostedTarget(env.SPLITCH_PLATFORM_TARGET)) return true;
  if (!env.CONTROL_PANEL_ORIGIN) return false;
  try {
    const origin = new URL(env.CONTROL_PANEL_ORIGIN);
    return (
      origin.protocol === "https:" &&
      origin.pathname === "/" &&
      origin.search === "" &&
      origin.hash === ""
    );
  } catch {
    return false;
  }
}

function workosAccessTokenVerifier(env: AuthApiEnv) {
  if (
    env.SPLITCH_PLATFORM_TARGET !== "shared-preview" &&
    env.SPLITCH_PLATFORM_TARGET !== "production"
  )
    return undefined;
  if (!env.WORKOS_JWKS_URI || !env.WORKOS_ISSUER || !env.WORKOS_AUTH_AUDIENCE) return undefined;
  return makeWorkOsAccessTokenVerifier({
    jwksUri: env.WORKOS_JWKS_URI,
    issuer: env.WORKOS_ISSUER,
    audience: env.WORKOS_AUTH_AUDIENCE,
  });
}

function accessTokenTrustContract(target: string | undefined): "local-hs256" | "rs256-jwks" {
  return target === "shared-preview" || target === "production" ? "rs256-jwks" : "local-hs256";
}
