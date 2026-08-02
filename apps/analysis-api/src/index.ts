import { WorkerEntrypoint } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget, routesDelegatedTo } from "@splitch/contracts";
import {
  createWorkerObservability,
  workerEmitter,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import {
  type AuthResolver,
  type DelegatedIdentity,
  delegatedAuthResolver,
  delegatedIdentityFor,
  McpDelegationReplayDurableObject,
  makeDurableMcpDelegationReplayGuard,
  makeMcpDelegationAuthResolver,
  notDelegatedResponse,
  type RateLimiter,
} from "@splitch/worker-runtime";
import { createApp } from "./app";
import type { AnalysisApiEnv } from "./env";
import { runScheduledSnapshot } from "./scheduled";
import { createTinybirdCopyTransport, createTinybirdReadTransport } from "./tinybird";

const allowLimiter: RateLimiter = () => ({ limited: false });
/** The operations `api.splitch.dev` may hand this Worker over the binding (ADR-0046). */
const delegatedRoutes = routesDelegatedTo("analysis-api");
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

/** Binding-only entrypoint for reads the Control Plane Worker already authorized. */
export class ControlPlaneEntrypoint extends WorkerEntrypoint<AnalysisApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    const identity = delegatedIdentityFor(request, delegatedRoutes);
    if (!identity) return notDelegatedResponse(request);
    return handleRequest(request, this.env, this.ctx, { kind: "control-plane", identity });
  }
}

type AnalysisRequestAuthority =
  | { kind: "mcp" }
  | { kind: "control-plane"; identity: DelegatedIdentity };

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
    door: authority ? "binding" : "public",
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
    return delegatedAuthResolver(authority.identity);
  }
  // This Worker surfaces no route of its own (ADR-0046): `/results` and `/usage`
  // are addressed at the Control Plane, which authorizes the caller and forwards
  // over the binding carrying an identity. The public door therefore mounts an
  // empty table and has no credential to verify -- building a real verifier here
  // would only turn a dropped var into a 500 on a hostname that must 404.
  return refuseUnauthorized;
}

const refuseUnauthorized: AuthResolver = () => ({ ok: false, reason: "UNAUTHORIZED" });

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
