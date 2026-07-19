import { WorkerEntrypoint } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import {
  makeDurableMcpDelegationReplayGuard,
  makeMcpDelegationAuthResolver,
  McpDelegationReplayDurableObject,
  type RateLimiter,
} from "@splitch/worker-runtime";
import { createApp } from "./app";
import { AssignmentStoreDurableObject } from "./assignment/assignment-store-do";
import { KvAssignmentStore } from "./assignment/kv-assignment-store";
import {
  makeControlPlaneAuthResolver,
  makeHttpJwksFetcher,
  makeJwksVerifier,
  makeSessionStore,
} from "./control-plane-auth";
import { makeDataPlaneAuthResolver } from "./data-plane-auth";
import type { EvaluationApiEnv } from "./env";
import { makeHttpEvaluationCommitSink } from "./evaluation-commit-sink";
import { makeHttpEvaluationUsageSink } from "./evaluation-usage-sink";
import { makeEnvSaltStore } from "./local-salt-store";
import { KvProvider } from "./provider/kv-provider";

const service = "splitch-evaluation-api";

const allowLimiter: RateLimiter = () => ({ limited: false });

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<EvaluationApiEnv>;

export default wrapWorkerHandler(handler, { surface: "evaluation-api" });

export class McpEntrypoint extends WorkerEntrypoint<EvaluationApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return handleRequest(request, this.env, this.ctx, true);
  }
}

async function handleRequest(
  request: Request,
  env: EvaluationApiEnv,
  ctx: ExecutionContext,
  mcpDelegation = false,
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

  const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
  const jwksUri = env.AUTH_JWKS_URI ?? `${controlPlaneAudience}/.well-known/jwks.json`;
  const saltStore = makeEnvSaltStore(env);
  const app = createApp({
    authResolver: mcpDelegation
      ? makeMcpDelegationAuthResolver({
          owner: "evaluation-api",
          secret: requiredMcpDelegationSecret(env.MCP_EVALUATION_DELEGATION_SECRET),
          replayGuard: makeDurableMcpDelegationReplayGuard(
            requiredMcpReplayBinding(env.MCP_DELEGATION_REPLAY),
          ),
        })
      : makeControlPlaneAuthResolver({
          verifier: makeJwksVerifier({
            fetchJwks: makeHttpJwksFetcher(jwksUri),
            controlPlaneAudience,
          }),
          sessions: makeSessionStore(env.SESSION_STORE),
        }),
    dataPlaneAuthResolver: makeDataPlaneAuthResolver(env.CREDENTIAL_STORE),
    rateLimiter: allowLimiter,
    provider: new KvProvider(env.CONFIG_STORE),
    assignmentStore: new KvAssignmentStore(
      env.ASSIGNMENTS_KV,
      env.ASSIGNMENT_STORE_WRITER,
      saltStore,
    ),
    exposureAssembly: {
      saltStore,
      sourceId: env.SPLITCH_SOURCE_ID ?? "local",
    },
    evaluationCommitSink: makeHttpEvaluationCommitSink({
      endpoint: env.EVENT_INGEST_URL,
      fetcher: env.EVENT_INGEST,
      token: env.SPLITCH_EVENT_INGEST_TOKEN,
    }),
    evaluationUsageSink: makeHttpEvaluationUsageSink({
      endpoint: env.EVENT_INGEST_URL,
      fetcher: env.EVENT_INGEST,
      token: env.SPLITCH_EVENT_INGEST_TOKEN,
    }),
    waitUntil: (promise) => ctx.waitUntil(promise),
    logger: console,
    observability: createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("evaluation-api", ctx),
    ),
  });
  return app.fetch(request, env);
}

function requiredMcpDelegationSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error("evaluation-api: MCP_EVALUATION_DELEGATION_SECRET is required");
  }
  return secret;
}

function requiredMcpReplayBinding(
  binding: EvaluationApiEnv["MCP_DELEGATION_REPLAY"],
): NonNullable<EvaluationApiEnv["MCP_DELEGATION_REPLAY"]> {
  if (!binding) throw new Error("evaluation-api: MCP_DELEGATION_REPLAY is required");
  return binding;
}

export { AssignmentStoreDurableObject, McpDelegationReplayDurableObject };
