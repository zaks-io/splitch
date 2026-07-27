import { WorkerEntrypoint } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import type { ScopedAnalysisIdentity } from "@splitch/control-plane-sdk/panel-experiments";
import {
  createWorkerObservability,
  workerEmitter,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import {
  McpDelegationReplayDurableObject,
  makeDurableMcpDelegationReplayGuard,
  makeMcpDelegationAuthResolver,
  type RateLimiter,
} from "@splitch/worker-runtime";
import { createApp } from "./app";
import {
  makeControlPlaneAuthResolver,
  makeHttpJwksFetcher,
  makeJwksVerifier,
  makeSessionStore,
} from "./auth";
import type { AnalysisApiEnv } from "./env";
import { runScheduledSnapshot } from "./scheduled";
import { scopedIdentityForRequest } from "./scoped-service-identity";
import { createTinybirdCopyTransport, createTinybirdReadTransport } from "./tinybird";

const allowLimiter: RateLimiter = () => ({ limited: false });
const verifierCache = new Map<string, ReturnType<typeof makeJwksVerifier>>();
const service = "splitch-analysis-api";

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  scheduled(event, env, ctx): void {
    runScheduled(event, env, ctx);
  },
} satisfies ExportedHandler<AnalysisApiEnv>;

export default wrapWorkerHandler(handler, { surface: "analysis-api" });

export class McpEntrypoint extends WorkerEntrypoint<AnalysisApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return handleRequest(request, this.env, this.ctx, { kind: "mcp" });
  }
}

/** Binding-only entrypoint for Run-scoped reads authorized by the Control Plane Worker. */
export class ControlPlaneEntrypoint extends WorkerEntrypoint<AnalysisApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    const identity = await scopedIdentityForRequest(request);
    if (!identity) return new Response("not found", { status: 404 });
    return handleRequest(request, this.env, this.ctx, { kind: "control-plane", identity });
  }
}

type AnalysisRequestAuthority =
  | { kind: "mcp" }
  | { kind: "control-plane"; identity: ScopedAnalysisIdentity };

async function handleRequest(
  request: Request,
  env: AnalysisApiEnv,
  ctx: ExecutionContext,
  authority?: AnalysisRequestAuthority,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/") {
    return Response.json(
      createHealthResponse(
        service,
        parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
        env.SPLITCH_DEPLOYED_COMMIT_SHA,
      ),
    );
  }

  const app = createApp({
    authResolver: requestAuthResolver(env, authority),
    rateLimiter: allowLimiter,
    tinybird: createTinybirdReadTransport(env),
    platformTarget: env.SPLITCH_PLATFORM_TARGET,
    observability: createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("analysis-api", ctx),
    ),
  });
  return app.fetch(request, env);
}

function requestAuthResolver(env: AnalysisApiEnv, authority: AnalysisRequestAuthority | undefined) {
  if (authority?.kind === "mcp") {
    return makeMcpDelegationAuthResolver({
      owner: "analysis-api",
      secret: requiredMcpDelegationSecret(env.MCP_ANALYSIS_DELEGATION_SECRET),
      replayGuard: makeDurableMcpDelegationReplayGuard(
        requiredMcpReplayBinding(env.MCP_DELEGATION_REPLAY),
      ),
    });
  }
  if (authority?.kind === "control-plane") {
    const { identity } = authority;
    return async () => ({
      ok: true as const,
      principal: {
        kind: "control-plane-token" as const,
        id: identity.actorId,
        scopes: [],
        orgId: null,
        appId: identity.appId,
        environmentId: identity.environmentId,
        // Internal service-to-service identity minted by the control-plane
        // Worker, not by an auth door.
        authDoor: null,
      },
    });
  }
  return publicAuthResolver(env);
}

function requiredMcpDelegationSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error("analysis-api: MCP_ANALYSIS_DELEGATION_SECRET is required");
  }
  return secret;
}

function requiredMcpReplayBinding(
  binding: AnalysisApiEnv["MCP_DELEGATION_REPLAY"],
): NonNullable<AnalysisApiEnv["MCP_DELEGATION_REPLAY"]> {
  if (!binding) throw new Error("analysis-api: MCP_DELEGATION_REPLAY is required");
  return binding;
}

function runScheduled(
  event: ScheduledController,
  env: AnalysisApiEnv,
  ctx: ExecutionContext,
): void {
  const axiomEmitter = workerEmitter(env, workerObservabilityWithWaitUntil("analysis-api", ctx));
  ctx.waitUntil(
    runScheduledSnapshot({
      cron: event.cron,
      logger: {
        log: (message, ...args) => {
          const fields =
            args[0] && typeof args[0] === "object" ? (args[0] as Record<string, unknown>) : {};
          axiomEmitter.log("info", String(message), fields);
        },
        error: (message, ...args) => {
          const fields =
            args[0] && typeof args[0] === "object" ? (args[0] as Record<string, unknown>) : {};
          axiomEmitter.log("error", String(message), fields);
        },
      },
      scheduledTimeMs: event.scheduledTime,
      tinybird: createTinybirdCopyTransport(env),
    }),
  );
}

export { McpDelegationReplayDurableObject };

function publicAuthResolver(env: AnalysisApiEnv) {
  const controlPlaneAudience = requiredConfig(env.CONTROL_PLANE_ORIGIN, "CONTROL_PLANE_ORIGIN");
  const jwksUri = requiredConfig(env.AUTH_JWKS_URI, "AUTH_JWKS_URI");
  const expectedIssuer = requiredConfig(env.AUTH_API_ORIGIN, "AUTH_API_ORIGIN");
  return makeControlPlaneAuthResolver({
    verifier: verifierFor({ jwksUri, controlPlaneAudience, expectedIssuer }),
    sessions: makeSessionStore(env.SESSION_STORE),
  });
}
function requiredConfig(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`analysis-api: ${name} config is required`);
  }
  return value;
}

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
