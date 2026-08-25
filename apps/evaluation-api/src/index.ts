import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createHealthResponse,
  getRoute,
  parsePlatformTarget,
  routesDelegatedTo,
} from "@splitch/contracts";
import {
  createWorkerFaultReporter,
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
  notDelegatedResponse,
  type RateLimiter,
} from "@splitch/worker-runtime";
import { createApp } from "./app";
import { AssignmentStoreDurableObject } from "./assignment/assignment-store-do";
import { DurableHoldoverWriteAppInventoryClient } from "./assignment/holdover-write-app-inventory-client";
import { HoldoverWriteAppInventoryDurableObject } from "./assignment/holdover-write-app-inventory-do";
import { DurableHoldoverWriteCoordinator } from "./assignment/holdover-write-outbox";
import {
  requiredHoldoverWriteAppInventoryBinding,
  requiredHoldoverWriteOutboxBinding,
} from "./assignment/holdover-write-outbox-binding";
import { HoldoverWriteOutboxDurableObject } from "./assignment/holdover-write-outbox-do";
import { KvAssignmentStore } from "./assignment/kv-assignment-store";
import {
  makeControlPlaneAuthResolver,
  makeCachedJwksVerifier,
  makeSessionStore,
} from "./control-plane-auth";
import { makeDataPlaneAuthResolver } from "./data-plane-auth";
import type { EvaluationApiEnv } from "./env";
import { makeHttpEvaluationCommitSink } from "./evaluation-commit-sink";
import { makeHttpEvaluationUsageSink } from "./evaluation-usage-sink";
import { makeHttpExposureIngestSink } from "./exposure-redemption";
import { DurableExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import { requiredExposureRedemptionClaimsBinding } from "./exposure-redemption-claims-binding";
import { ExposureRedemptionClaimDurableObject } from "./exposure-redemption-do";
import { makeEnvSaltStore } from "./local-salt-store";
import { exposureTicketKeyFromEnv } from "./local-ticket-key";
import { runtimeKvProvider } from "./provider/runtime-provider";

const service = "splitch-evaluation-api";

const allowLimiter: RateLimiter = () => ({ limited: false });
/** The operations `api.splitch.dev` may hand this Worker over the binding (ADR-0046). */
const delegatedRoutes = routesDelegatedTo("evaluation-api");
const holdoverWriteOutboxCleanupRoute = getRoute("holdover_write_outbox_delete");
if (!holdoverWriteOutboxCleanupRoute) {
  throw new Error("evaluation-api: holdover write outbox cleanup route is not registered");
}
const bindingRoutes = [...delegatedRoutes, holdoverWriteOutboxCleanupRoute];

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<EvaluationApiEnv>;

/** Unwrapped fetch handler — tests drive this so startup binding checks stay load-bearing. */
export const evaluationApiHandler = handler;

export default wrapWorkerHandler(handler, { surface: "evaluation-api" });

const controlPlaneHandler = wrapWorkerHandler(
  {
    async fetch(request, env, ctx): Promise<Response> {
      const identity = delegatedIdentityFor(request, bindingRoutes);
      if (!identity) return notDelegatedResponse(request);
      return handleRequest(request, env, ctx, { kind: "control-plane", identity });
    },
  } satisfies ExportedHandler<EvaluationApiEnv>,
  { surface: "evaluation-api" },
);

/**
 * Binding-only entrypoint for `flags_test_eval`. The operation takes a
 * control-plane token, so it is addressed at `api.splitch.dev` even though this
 * Worker executes it, and the Control Plane hands it over having already
 * authorized the caller (ADR-0046).
 */
export class ControlPlaneEntrypoint extends WorkerEntrypoint<EvaluationApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return controlPlaneHandler.fetch(
      request as Parameters<typeof controlPlaneHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }
}

type EvaluationRequestAuthority = { kind: "control-plane"; identity: DelegatedIdentity };

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
  const exposureRedemptionClaims = requiredExposureRedemptionClaimsBinding(
    env.EXPOSURE_REDEMPTION_CLAIMS,
  );
  const holdoverWriteOutbox = requiredHoldoverWriteOutboxBinding(env.HOLDOVER_WRITE_OUTBOX);
  const holdoverWriteAppInventory = new DurableHoldoverWriteAppInventoryClient(
    requiredHoldoverWriteAppInventoryBinding(env.HOLDOVER_WRITE_APP_INVENTORY),
  );
  const reportPropagationBreach = createWorkerFaultReporter(
    env,
    workerObservabilityWithWaitUntil("evaluation-api", ctx),
  );
  const saltStore = makeEnvSaltStore(env);
  const app = createApp({
    door: authority ? "binding" : "public",
    authResolver: requestAuthResolver(env, url, authority),
    dataPlaneAuthResolver: makeDataPlaneAuthResolver(env.CREDENTIAL_STORE),
    rateLimiter: allowLimiter,
    delegationBindings: { "event-ingest-api": env.EVENT_INGEST },
    provider: runtimeKvProvider(
      env,
      (breach) => reportPropagationBreach("flag_config_propagation_breach", { ...breach }),
      (promise) => ctx.waitUntil(promise),
    ),
    assignmentStore: new KvAssignmentStore(
      env.ASSIGNMENTS_KV,
      env.ASSIGNMENT_STORE_WRITER,
      saltStore,
    ),
    holdoverWrite: new DurableHoldoverWriteCoordinator(holdoverWriteOutbox),
    holdoverWriteOutboxCleanup: {
      assignmentsKv: env.ASSIGNMENTS_KV,
      holdoverWriteOutbox,
      holdoverWriteAppInventory,
    },
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
    exposureRedemptionClaims: new DurableExposureRedemptionClaimStore(exposureRedemptionClaims),
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
  const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
  const jwksUri = env.AUTH_JWKS_URI ?? `${controlPlaneAudience}/.well-known/jwks.json`;
  return makeControlPlaneAuthResolver({
    verifier: makeCachedJwksVerifier({
      jwksUri,
      controlPlaneAudience,
    }),
    sessions: makeSessionStore(env.SESSION_STORE),
  });
}

/**
 * The replay-guard Durable Object class stays exported while its namespace stays
 * bound: MCP now reaches this Worker only through the Control Plane, so nothing
 * claims a replay id here, but dropping a Durable Object class needs its own
 * `deleted_classes` migration.
 */
export {
  AssignmentStoreDurableObject,
  ExposureRedemptionClaimDurableObject,
  HoldoverWriteAppInventoryDurableObject,
  HoldoverWriteOutboxDurableObject,
  McpDelegationReplayDurableObject,
};
