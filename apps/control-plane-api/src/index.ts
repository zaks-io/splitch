import { WorkerEntrypoint } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import {
  createWorkerObservability,
  workerEmitter,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import {
  makeDurableMcpDelegationReplayGuard,
  makeMcpDelegationAuthResolver,
  McpDelegationReplayDurableObject,
} from "@splitch/worker-runtime";
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
import { panelExperimentsList } from "./panel-experiments";
import { rateLimiterForTarget } from "./rate-limit";
import { makeSessionStore } from "./session-store";

const service = "splitch-control-plane-api";
const CONTROL_PANEL_APPS_CREATE_PATH = /^\/orgs\/[^/]+\/apps\/?$/;
const CONTROL_PANEL_EXPERIMENTS_PATH = "/control-panel/experiments/list";

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

/** Binding-only entrypoint used by the Control Panel for authenticated mutations. */
export class ControlPanelEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === CONTROL_PANEL_EXPERIMENTS_PATH) {
      return handlePanelExperimentsRequest(request, this.env);
    }
    if (request.method !== "POST" || !CONTROL_PANEL_APPS_CREATE_PATH.test(url.pathname)) {
      return new Response("not found", { status: 404 });
    }
    return handleRequest(request, this.env, this.ctx, "panel");
  }
}

/** Binding-only entrypoint for one-operation MCP delegations. */
export class McpEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return handleRequest(request, this.env, this.ctx, "mcp");
  }
}

async function handlePanelExperimentsRequest(
  request: Request,
  env: ControlPlaneApiEnv,
): Promise<Response> {
  if (request.headers.has("authorization")) return new Response("not found", { status: 404 });
  const sessionHash = request.headers.get("x-splitch-panel-session");
  if (!sessionHash) return unauthorized();
  const actor = await makeSessionStore(env.SESSION_STORE).loadPanelSessionActor(
    sessionHash,
    Math.floor(Date.now() / 1000),
  );
  if (!actor) return unauthorized();
  const input = await request.json().catch(() => null);
  if (!isPanelExperimentsInput(input)) {
    return Response.json(
      { code: "VALIDATION_ERROR", message: "appId and environmentId are required", details: {} },
      { status: 400 },
    );
  }
  try {
    return await panelExperimentsList(
      { repo: createRepository(env.DB), analysis: env.ANALYSIS_API },
      { actorId: actor.userId, ...input },
    );
  } catch {
    return Response.json(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "Experiment Run health is unavailable",
        details: { retryAfterMs: 30_000 },
      },
      { status: 503 },
    );
  }
}

function isPanelExperimentsInput(
  value: unknown,
): value is { appId: string; environmentId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "appId" in value &&
    typeof value.appId === "string" &&
    value.appId.length > 0 &&
    "environmentId" in value &&
    typeof value.environmentId === "string" &&
    value.environmentId.length > 0
  );
}

function unauthorized(): Response {
  return Response.json(
    { code: "UNAUTHORIZED", message: "authentication required", details: {} },
    { status: 401 },
  );
}

async function handleRequest(
  request: Request,
  env: ControlPlaneApiEnv,
  ctx: ExecutionContext,
  authMode: "public" | "panel" | "mcp" = "public",
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

  const publicAuthResolver = makeControlPlaneAuthResolver(
    {
      verifier,
      sessions: makeSessionStore(env.SESSION_STORE),
    },
    { allowPanelSession: authMode === "panel" },
  );
  const app = createApp({
    authResolver:
      authMode === "mcp"
        ? makeMcpDelegationAuthResolver({
            owner: "control-plane-api",
            secret: requiredMcpDelegationSecret(env.MCP_CONTROL_PLANE_DELEGATION_SECRET),
            replayGuard: makeDurableMcpDelegationReplayGuard(
              requiredMcpReplayBinding(env.MCP_DELEGATION_REPLAY),
            ),
          })
        : publicAuthResolver,
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
}

function requiredMcpDelegationSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error("control-plane-api: MCP_CONTROL_PLANE_DELEGATION_SECRET is required");
  }
  return secret;
}

function requiredMcpReplayBinding(
  binding: ControlPlaneApiEnv["MCP_DELEGATION_REPLAY"],
): NonNullable<ControlPlaneApiEnv["MCP_DELEGATION_REPLAY"]> {
  if (!binding) throw new Error("control-plane-api: MCP_DELEGATION_REPLAY is required");
  return binding;
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
  McpDelegationReplayDurableObject,
};
