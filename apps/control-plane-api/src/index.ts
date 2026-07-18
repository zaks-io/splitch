import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import {
  createWorkerObservability,
  workerEmitter,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import { createApp } from "./app";
import { authJwksUri } from "./auth-jwks-config";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { ConfigStoreDurableObject, durableConfigStoreAccess } from "./config-store-do";
import { CredentialCacheBackfillDurableObject } from "./credential-cache-backfill-do";
import {
  CredentialCacheWriterDurableObject,
  durableCredentialCacheWriterAccess,
} from "./credential-cache-writer-do";
import type { ControlPlaneApiEnv } from "./env";
import { makeHttpJwksFetcher, makeJwksVerifier } from "./jwks-verify";
import { makeSessionCacheMemberProfileResolver } from "./member-profile-cache";
import { rateLimiterForTarget } from "./rate-limit";
import { makeSessionStore } from "./session-store";

const service = "splitch-control-plane-api";

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      const response = Response.json(
        createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      );
      if (env.SPLITCH_LOCAL_E2E_RUN_ID) {
        response.headers.set("x-splitch-local-e2e-run-id", env.SPLITCH_LOCAL_E2E_RUN_ID);
      }
      return response;
    }
    if (url.pathname.startsWith("/internal/credential-cache-backfill")) {
      return handleCredentialCacheBackfillGate(request, env, url);
    }

    const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
    const jwksUri = authJwksUri(env);
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
      credentialCacheWriter: durableCredentialCacheWriterAccess(env.CREDENTIAL_CACHE_WRITER),
      configStore: durableConfigStoreAccess(env.CONFIG_STORE_WRITER),
      logger: console,
      memberProfileResolver: makeSessionCacheMemberProfileResolver(env.SESSION_STORE),
      observability: createWorkerObservability(
        env,
        workerObservabilityWithWaitUntil("control-plane-api", ctx),
      ),
    });

    return app.fetch(request, env);
  },

  scheduled(event, env, ctx): void {
    ctx.waitUntil(runDemoReaper(env, event, ctx));
    ctx.waitUntil(runCredentialCacheBackfill(env));
  },
} satisfies ExportedHandler<ControlPlaneApiEnv>;

export default wrapWorkerHandler(handler, { surface: "control-plane-api" });

async function runDemoReaper(
  env: ControlPlaneApiEnv,
  event: ScheduledController,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const now = new Date(event.scheduledTime).toISOString();
  const repo = createRepository(env.DB);
  const result = await repo.identity.reapExpiredProvisionalOrganizations(now);
  const claimArtifacts = await repo.claim.purgeExpiredClaimArtifacts({ now, limit: 100 });
  workerEmitter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx)).log(
    "info",
    "demo-reaper",
    {
      service,
      job: "demo-reaper",
      cron: event.cron,
      candidates: result.candidates,
      reaped: result.reaped,
      claimArtifacts,
    },
  );
}

async function runCredentialCacheBackfill(env: ControlPlaneApiEnv): Promise<void> {
  await env.CREDENTIAL_CACHE_BACKFILL.getByName("schema-v1").fetch("https://backfill/run", {
    method: "POST",
  });
}

async function handleCredentialCacheBackfillGate(
  request: Request,
  env: ControlPlaneApiEnv,
  url: URL,
): Promise<Response> {
  if (
    !env.SPLITCH_DEPLOY_GATE_TOKEN ||
    request.headers.get("authorization") !== `Bearer ${env.SPLITCH_DEPLOY_GATE_TOKEN}`
  ) {
    return new Response("not found", { status: 404 });
  }
  const suffix = url.pathname.replace("/internal/credential-cache-backfill", "") || "/status";
  if (
    (suffix !== "/run" && suffix !== "/status") ||
    (suffix === "/run" && request.method !== "POST")
  ) {
    return new Response("not found", { status: 404 });
  }
  return env.CREDENTIAL_CACHE_BACKFILL.getByName("schema-v1").fetch(
    new URL(suffix, "https://backfill.internal"),
    suffix === "/run" ? { method: "POST" } : undefined,
  );
}

export {
  ConfigStoreDurableObject,
  CredentialCacheBackfillDurableObject,
  CredentialCacheWriterDurableObject,
};
