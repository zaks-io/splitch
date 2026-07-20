import { WorkerEntrypoint } from "cloudflare:workers";
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
import { parseControlPanelBindingOperation } from "./control-panel-operation";
import { CredentialCacheBackfillDurableObject } from "./credential-cache-backfill-do";
import {
  CredentialCacheWriterDurableObject,
  durableCredentialCacheWriterAccess,
} from "./credential-cache-writer-do";
import type { ControlPlaneApiEnv } from "./env";
import { makeHttpJwksFetcher, makeJwksVerifier } from "./jwks-verify";
import { makeSessionCacheMemberProfileResolver } from "./member-profile-cache";
import { PanelDelegationReplayDurableObject } from "./panel-delegation-replay-do";
import { makePanelDelegationReplayStore } from "./panel-identity-replay";
import { makePanelSessionAccess } from "./panel-session-access";
import { rateLimiterForTarget } from "./rate-limit";
import { makeSessionStore } from "./session-store";

const service = "splitch-control-plane-api";
const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  scheduled(event, env, ctx): void {
    ctx.waitUntil(runDemoReaper(env, event, ctx));
    ctx.waitUntil(runCredentialCacheBackfill(env));
  },
} satisfies ExportedHandler<ControlPlaneApiEnv>;

export default wrapWorkerHandler(handler, { surface: "control-plane-api" });

/** Bounded V1 bridge used only while an old Control Panel remains live during deploy or rollback. */
export class ControlPanelEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    if (!boundedLegacyIdentityEnabled(this.env)) {
      return new Response("not found", { status: 404 });
    }
    if (!parseControlPanelBindingOperation(request)) {
      return new Response("not found", { status: 404 });
    }
    return handleRequest(request, this.env, this.ctx, "bounded-legacy");
  }
}

/** Binding-only V2 entrypoint used by the Control Panel for signed least-privilege delegation. */
export class SignedControlPanelEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    if (!parseControlPanelBindingOperation(request)) {
      return new Response("not found", { status: 404 });
    }
    return handleRequest(request, this.env, this.ctx, "signed");
  }
}

type PanelProtocol = "none" | "signed" | "bounded-legacy";

async function handleRequest(
  request: Request,
  env: ControlPlaneApiEnv,
  ctx: ExecutionContext,
  panelProtocol: PanelProtocol = "none",
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/") {
    const response = Response.json(
      createHealthResponse(
        service,
        parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
        env.SPLITCH_DEPLOYED_COMMIT_SHA,
      ),
    );
    if (env.SPLITCH_LOCAL_E2E_RUN_ID) {
      response.headers.set("x-splitch-local-e2e-run-id", env.SPLITCH_LOCAL_E2E_RUN_ID);
    }
    return response;
  }
  if (url.pathname.startsWith("/internal/credential-cache-backfill")) {
    return handleCredentialCacheBackfillGate(request, env, url);
  }
  const liveUpdateTestControl = await handleLiveUpdateTestControl(request, env, url);
  if (liveUpdateTestControl) return liveUpdateTestControl;

  const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
  const jwksUri = authJwksUri(env);
  const verifier = makeJwksVerifier({
    fetchJwks: makeHttpJwksFetcher(jwksUri),
    controlPlaneAudience,
  });

  const repo = createRepository(env.DB);
  const app = createApp({
    authResolver: makeControlPlaneAuthResolver(
      {
        verifier,
        sessions: makeSessionStore(env.SESSION_STORE),
      },
      {
        allowPanelDelegation: panelProtocol === "signed",
        allowBoundedLegacyPanelIdentity: panelProtocol === "bounded-legacy",
        ...(panelProtocol !== "none"
          ? {
              ...(panelProtocol === "signed"
                ? { panelDelegationSecret: requiredPanelDelegationSecret(env) }
                : {}),
              panelAccess: makePanelSessionAccess(repo),
              panelDelegationReplay: makePanelDelegationReplayStore(env.PANEL_DELEGATION_REPLAY),
            }
          : {}),
      },
    ),
    rateLimiter: rateLimiterForTarget(env.SPLITCH_PLATFORM_TARGET, panelProtocol !== "none"),
    repo,
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
}

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

async function handleLiveUpdateTestControl(
  request: Request,
  env: ControlPlaneApiEnv,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/__test/live-updates/")) return null;
  if (
    !env.SPLITCH_LOCAL_E2E_RUN_ID ||
    request.method !== "POST" ||
    request.headers.get("x-splitch-local-e2e-run-id") !== env.SPLITCH_LOCAL_E2E_RUN_ID
  ) {
    return new Response("not found", { status: 404 });
  }
  const match = url.pathname.match(/^\/__test\/live-updates\/([^/]+)\/([^/]+)\/(up|down)$/);
  if (!match) return new Response("not found", { status: 404 });
  const [, appId, environmentId, state] = match;
  if (!appId || !environmentId || !state) return new Response("not found", { status: 404 });
  await env.CONFIG_STORE_WRITER.getByName(`${appId}:${environmentId}`).setLiveUpdatesAvailable(
    state === "up",
  );
  return Response.json({ ok: true, state });
}

export {
  ConfigStoreDurableObject,
  CredentialCacheBackfillDurableObject,
  CredentialCacheWriterDurableObject,
  PanelDelegationReplayDurableObject,
};

function requiredPanelDelegationSecret(env: ControlPlaneApiEnv): string {
  if (env.CONTROL_PANEL_DELEGATION_SECRET) return env.CONTROL_PANEL_DELEGATION_SECRET;
  throw new Error("control-plane-api: CONTROL_PANEL_DELEGATION_SECRET is required");
}

function boundedLegacyIdentityEnabled(env: ControlPlaneApiEnv): boolean {
  const expiresAt = env.CONTROL_PANEL_LEGACY_IDENTITY_EXPIRES_AT;
  return (
    env.CONTROL_PANEL_LEGACY_IDENTITY_MODE === "bounded-rollout" &&
    typeof expiresAt === "string" &&
    /^\d{10}$/u.test(expiresAt) &&
    Number(expiresAt) > Math.floor(Date.now() / 1000)
  );
}
