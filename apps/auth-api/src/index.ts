import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import {
  assertAccessTokenSecretCanSign,
  makeEphemeralAccessTokenPrivateJwk,
} from "./access-token-key";
import { createApp } from "./app";
import { makeFixtureDeviceFlow, makeWorkOsDeviceFlow } from "./device-flow";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import type { AuthApiEnv } from "./env";
import { makeJtiCache } from "./jti-cache";
import { fetchJwks } from "./jwks";
import type { SmokeClientCredentials } from "./oauth-routes";
import { makeFixtureOtp, makeIdempotencyStore } from "./otp";
import { makeRateLimiter } from "./rate-limit";
import { makeKvRevocationStore } from "./revocation";
import { makeTokenSigner } from "./token-exchange";
import { makeFixtureTurnstile, makeRuntimeTurnstile } from "./turnstile";
import { makeFixtureWorkOs, makeHostedWorkOs } from "./workos";
import { makeWorkOsAccessTokenVerifier } from "./workos-access-token";

const service = "splitch-auth-api";

const fixtureWorkos = makeFixtureWorkOs();
const otp = makeFixtureOtp();
const fixtureTurnstile = makeFixtureTurnstile();
const rateLimiter = makeRateLimiter();
const idempotency = makeIdempotencyStore();
let localAccessTokenSecret: Promise<string> | undefined;
let signableAccessTokenSecret: string | undefined;

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
    // Resolved before /health answers: a Worker whose signing key cannot mint a
    // token is not healthy, and health is the probe an operator reaches for
    // first. The reason travels in the body so the diagnosis does not require
    // reading logs; the cause is logged because the body must not carry it.
    let accessSecret: string;
    try {
      accessSecret = await accessTokenSecret(env);
    } catch (cause) {
      console.error("auth-api access-token key is unusable", cause);
      return Response.json(
        {
          error: "server_error",
          error_description: "ACCESS_TOKEN_SECRET is not a usable RS256 signing key",
        },
        { status: 500 },
      );
    }
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json(
        createHealthResponse(
          service,
          parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
          env.SPLITCH_DEPLOYED_COMMIT_SHA,
        ),
      );
    }

    const repo = createRepository(env.DB);
    const origin = env.AUTH_API_ORIGIN ?? url.origin;
    const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? "http://localhost:8787";
    const mcpAudience = env.MCP_ORIGIN;
    const assertionSecret = env.ASSERTION_SIGNING_SECRET ?? "local-dev-assertion-secret";
    const consentBaseUrl = env.CONTROL_PANEL_ORIGIN ?? "http://localhost:8787";
    const now = () => Date.now();
    const workos = hostedWorkOs(env);
    const deviceFlow = makeDeviceFlow(env);
    const tokenSigner = makeTokenSigner({
      assertionSecret,
      accessSecret,
      accessTokenTrustContract: "rs256-jwks",
      issuer: origin,
      controlPlaneAudience,
    });

    const app = createApp({
      repo,
      accessSecret,
      controlPlaneAudience,
      mcpAudience,
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
      claim: {
        repo,
        workos,
        otp,
        idempotency,
        tokenSigner,
        rateLimiter,
        consentBaseUrl,
        defaultResource: controlPlaneAudience,
        now,
        sessionStore: env.SESSION_STORE,
      },
      workosAccessTokens: workosAccessTokenVerifier(env),
      deviceFlow,
      deviceRefreshSessions: makeD1DeviceRefreshSessionStore(repo, {
        cache: env.SESSION_STORE,
        now,
      }),
      sessionStore: env.SESSION_STORE,
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
    (Boolean(env.WORKOS_API_KEY) &&
      Boolean(env.WORKOS_CLIENT_ID) &&
      Boolean(env.WORKOS_JWKS_URI) &&
      Boolean(env.WORKOS_ISSUER))
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
  if (!env.WORKOS_JWKS_URI || !env.WORKOS_ISSUER || !env.WORKOS_CLIENT_ID) return undefined;
  return makeWorkOsAccessTokenVerifier({
    jwksUri: env.WORKOS_JWKS_URI,
    issuer: env.WORKOS_ISSUER,
    clientId: env.WORKOS_CLIENT_ID,
  });
}

/**
 * The signer is RS256-only (`accessTokenTrustContract: "rs256-jwks"` above), so a
 * secret that cannot import as an RS256 signing key can never mint a token.
 *
 * WHY this is checked at config time and not left to the signer: a presence-only
 * check boots a Worker that reports healthy and then throws on every single mint,
 * which reaches the caller as an opaque `server_error`. Production ran that way
 * with a leftover HMAC secret and no door could issue a token. The same check
 * runs in the deploy gate (scripts/lib/hosted-worker-secrets.mjs) so a bad secret
 * fails before the Worker is replaced; this is the runtime half of that contract.
 *
 * Memoized on the value: the import is per-isolate work, not per-request.
 */
async function accessTokenSecret(env: AuthApiEnv): Promise<string> {
  if (env.ACCESS_TOKEN_SECRET) {
    if (env.ACCESS_TOKEN_SECRET !== signableAccessTokenSecret) {
      await assertAccessTokenSecretCanSign(env.ACCESS_TOKEN_SECRET);
      signableAccessTokenSecret = env.ACCESS_TOKEN_SECRET;
    }
    return env.ACCESS_TOKEN_SECRET;
  }
  if (isHostedTarget(env.SPLITCH_PLATFORM_TARGET)) {
    throw new Error("ACCESS_TOKEN_SECRET is required for hosted targets");
  }
  localAccessTokenSecret ??= makeEphemeralAccessTokenPrivateJwk();
  return localAccessTokenSecret;
}
