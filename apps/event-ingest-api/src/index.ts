import { WorkerEntrypoint } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget, routesDelegatedTo } from "@splitch/contracts";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import {
  delegatedIdentityFor,
  notDelegatedResponse,
  type Observability,
} from "@splitch/worker-runtime";
import { authenticateDelegatedDataPlaneCredential } from "./client-key-auth";
import { renderError } from "./errors";
import { handleEvaluationCommit } from "./evaluation-commit";
import { EvaluationCommitOutboxDurableObject } from "./evaluation-commit-outbox";
import { EvaluationUsageReplayWindowDurableObject } from "./evaluation-usage-replay-window";
import { handleEvaluationIngest, handleIngest } from "./ingest";
import { handleAuthorizedMetricEvent } from "./metric-event-ingest";
import { MetricEventOutboxDurableObject } from "./metric-event-outbox";
import { handleMetricEventQueue } from "./metric-event-queue";
import { MetricEventRateLimitDurableObject } from "./metric-event-rate-limit";
import type { Env } from "./types";

const service = "splitch-event-ingest-api";
const ingestPath = "/api/internal/exposures";
const evaluationIngestPath = "/api/internal/evaluations";
const evaluationCommitPath = "/api/internal/evaluation-commits";
const metricEventPath = "/api/sdk/events";
const metricEventRoutes = routesDelegatedTo("event-ingest-api").filter(
  (route) => route.operationId === "sdk_track",
);

/**
 * The token-authenticated writes the Evaluation Worker makes for its own
 * account: sealed Exposures, Evaluation commits and Evaluation usage. They carry
 * `SPLITCH_EVENT_INGEST_TOKEN`, not a delegated identity, and each handler
 * re-derives its own tenant scope from the request.
 */
const internalRoutes: Readonly<
  Record<
    string,
    {
      requestId: string;
      handle(request: Request, env: Env): Promise<Response>;
    }
  >
> = {
  [ingestPath]: { requestId: "ingest-request", handle: handleIngest },
  [evaluationIngestPath]: {
    requestId: "evaluation-ingest-request",
    handle: handleEvaluationIngest,
  },
  [evaluationCommitPath]: {
    requestId: "evaluation-commit-request",
    handle: handleEvaluationCommit,
  },
};

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return healthResponse(env);
    }
    const internal = await handleInternalRoute(request, env, observabilityFor(env, ctx), url);
    return internal ?? new Response("not found", { status: 404 });
  },
  queue: handleMetricEventQueue,
} satisfies ExportedHandler<Env, Record<string, unknown>>;

/**
 * Everything `splitch-evaluation-api` may send over the single `EVENT_INGEST`
 * service binding.
 *
 * One binding carries four operations, so this entrypoint has to recognise all
 * four or the ones it misses fail closed on deploy: the three internal sinks
 * above, plus the delegated `sdk_track` Metric Event whose Client Key the
 * Evaluation Worker already authorized at the public edge. A second binding
 * would give the same caller two identities for no gain.
 */
const delegatedHandler = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const observability = observabilityFor(env, ctx);
    const internal = await handleInternalRoute(request, env, observability, url);
    if (internal) return internal;
    if (request.method !== "POST" || url.pathname !== metricEventPath) {
      return notDelegatedResponse(request);
    }
    const identity = delegatedIdentityFor(request, metricEventRoutes);
    if (!identity) return notDelegatedResponse(request);
    recordRequest(observability, request, url, "metric-event-request");
    const credential = await authenticateDelegatedDataPlaneCredential(identity, env);
    if (!credential.ok) return renderError(credential.error);
    return handleAuthorizedMetricEvent(request, env, credential.value);
  },
} satisfies ExportedHandler<Env>;

const wrappedDelegatedHandler = wrapWorkerHandler(delegatedHandler, {
  surface: "event-ingest-api",
});

/** The public fetch must stay closed while Evaluation delegates over this binding. */
export class EvaluationEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return wrappedDelegatedHandler.fetch(
      request as Parameters<typeof wrappedDelegatedHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }
}

const wrappedHandler = wrapWorkerHandler({ fetch: handler.fetch }, { surface: "event-ingest-api" });

export default {
  fetch: wrappedHandler.fetch,
  queue: handler.queue,
} satisfies ExportedHandler<Env, Record<string, unknown>>;

function healthResponse(env: Env): Response {
  return Response.json(
    createHealthResponse(
      service,
      parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
      env.SPLITCH_DEPLOYED_COMMIT_SHA,
    ),
  );
}

function observabilityFor(env: Env, ctx: ExecutionContext): Observability {
  return createWorkerObservability(env, workerObservabilityWithWaitUntil("event-ingest-api", ctx));
}

/** The internal sink for this request, or null when it is not one. */
async function handleInternalRoute(
  request: Request,
  env: Env,
  observability: Observability,
  url: URL,
): Promise<Response | null> {
  const route = request.method === "POST" ? internalRoutes[url.pathname] : undefined;
  if (route === undefined) return null;
  recordRequest(observability, request, url, route.requestId);
  return route.handle(request, env);
}

function recordRequest(
  observability: Observability,
  request: Request,
  url: URL,
  fallbackRequestId: string,
): void {
  observability.onRequest?.({
    requestId: request.headers.get("x-request-id") ?? fallbackRequestId,
    method: request.method,
    path: url.pathname,
  });
}

export {
  EvaluationCommitOutboxDurableObject,
  EvaluationUsageReplayWindowDurableObject,
  MetricEventOutboxDurableObject,
  MetricEventRateLimitDurableObject,
};
