import { WorkerEntrypoint } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget, routesDelegatedTo } from "@splitch/contracts";
import {
  createWorkerObservability,
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
import { KvExposureRedemptionClaimStore, makeHttpExposureIngestSink } from "./exposure-redemption";
import { makeEnvSaltStore } from "./local-salt-store";
import { exposureTicketKeyFromEnv } from "./local-ticket-key";
import { KvProvider } from "./provider/kv-provider";

const service = "splitch-evaluation-api";

const allowLimiter: RateLimiter = () => ({ limited: false });
/** The operations `api.splitch.dev` may hand this Worker over the binding (ADR-0046). */
const delegatedRoutes = routesDelegatedTo("evaluation-api");

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<EvaluationApiEnv>;

export default wrapWorkerHandler(handler, { surface: "evaluation-api" });

export class McpEntrypoint extends WorkerEntrypoint<EvaluationApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return handleRequest(request, this.env, this.ctx, { kind: "mcp" });
  }
}

/**
 * Binding-only entrypoint for `flags_test_eval`. The operation takes a
 * control-plane token, so it is addressed at `api.splitch.dev` even though this
 * Worker executes it, and the Control Plane hands it over having already
 * authorized the caller (ADR-0046).
 */
export class ControlPlaneEntrypoint extends WorkerEntrypoint<EvaluationApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    const identity = delegatedIdentityFor(request, delegatedRoutes);
    if (!identity) return notDelegatedResponse(request);
    return handleRequest(request, this.env, this.ctx, { kind: "control-plane", identity });
  }
}

type EvaluationRequestAuthority =
  | { kind: "mcp" }
  | { kind: "control-plane"; identity: DelegatedIdentity };

async function handleRequest(
  request: Request,
  env: EvaluationApiEnv,
  ctx: ExecutionContext,
  authority?: EvaluationRequestAuthority,
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
  const saltStore = makeEnvSaltStore(env);
  const app = createApp({
    door: authority ? "binding" : "public",
    authResolver: requestAuthResolver(env, url, authority),
    dataPlaneAuthResolver: makeDataPlaneAuthResolver(env.CREDENTIAL_STORE),
    rateLimiter: allowLimiter,
    delegationBindings: { "event-ingest-api": env.EVENT_INGEST },
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
    exposureTicket: {
      saltStore,
      ticketKey: exposureTicketKeyFromEnv(env),
      previousTicketKey: env.EXPOSURE_TICKET_KEY_PREVIOUS,
    },
    exposureIngestSink: makeHttpExposureIngestSink({
      endpoint: env.EVENT_INGEST_URL,
      fetcher: env.EVENT_INGEST,
      token: env.SPLITCH_EVENT_INGEST_TOKEN,
    }),
    exposureRedemptionClaims: new KvExposureRedemptionClaimStore(env.CREDENTIAL_STORE),
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

/**
 * The `control-plane-token` resolver for this request. Both delegated kinds are
 * binding-only: the Worker on the other side already authorized the caller, so
 * what arrives is an identity to trust rather than a credential to verify. A
 * request that came in over the public hostname still goes through JWKS.
 */
function requestAuthResolver(
  env: EvaluationApiEnv,
  url: URL,
  authority: EvaluationRequestAuthority | undefined,
): AuthResolver {
  if (authority?.kind === "control-plane") {
    return delegatedAuthResolver(authority.identity);
  }
  if (authority?.kind === "mcp") {
    return makeMcpDelegationAuthResolver({
      owner: "evaluation-api",
      secret: requiredMcpDelegationSecret(env.MCP_EVALUATION_DELEGATION_SECRET),
      replayGuard: makeDurableMcpDelegationReplayGuard(
        requiredMcpReplayBinding(env.MCP_DELEGATION_REPLAY),
      ),
    });
  }
  const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
  const jwksUri = env.AUTH_JWKS_URI ?? `${controlPlaneAudience}/.well-known/jwks.json`;
  return makeControlPlaneAuthResolver({
    verifier: makeJwksVerifier({
      fetchJwks: makeHttpJwksFetcher(jwksUri),
      controlPlaneAudience,
    }),
    sessions: makeSessionStore(env.SESSION_STORE),
  });
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
