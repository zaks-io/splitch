import { WorkerEntrypoint } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import type { ScopedAnalysisIdentity } from "@splitch/control-plane-sdk/panel-experiments";
import {
  createWorkerObservability,
  workerEmitter,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import type { RateLimiter } from "@splitch/worker-runtime";
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
  },
} satisfies ExportedHandler<AnalysisApiEnv>;

export default wrapWorkerHandler(handler, { surface: "analysis-api" });

/** Binding-only entrypoint for Run-scoped reads authorized by the Control Plane Worker. */
export class ControlPlaneEntrypoint extends WorkerEntrypoint<AnalysisApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    const identity = await scopedIdentityForRequest(request);
    if (!identity) return new Response("not found", { status: 404 });
    return handleRequest(request, this.env, this.ctx, identity);
  }
}

async function handleRequest(
  request: Request,
  env: AnalysisApiEnv,
  ctx: ExecutionContext,
  scopedIdentity?: ScopedAnalysisIdentity,
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

  const authResolver = scopedIdentity
    ? async () => ({
        ok: true as const,
        principal: {
          kind: "control-plane-token" as const,
          id: scopedIdentity.actorId,
          scopes: [],
          orgId: null,
          appId: scopedIdentity.appId,
          environmentId: scopedIdentity.environmentId,
        },
      })
    : publicAuthResolver(env);
  const app = createApp({
    authResolver,
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
