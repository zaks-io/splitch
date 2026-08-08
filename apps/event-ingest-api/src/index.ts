import { WorkerEntrypoint } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget, routesDelegatedTo } from "@splitch/contracts";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import { delegatedIdentityFor, notDelegatedResponse } from "@splitch/worker-runtime";
import { authenticateDelegatedClientKey } from "./client-key-auth";
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
    const observability = createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("event-ingest-api", ctx),
    );

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json(
        createHealthResponse(
          service,
          parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
          env.SPLITCH_DEPLOYED_COMMIT_SHA,
        ),
      );
    }

    const route = request.method === "POST" ? internalRoutes[url.pathname] : undefined;
    if (route === undefined) return new Response("not found", { status: 404 });

    observability.onRequest?.({
      requestId: request.headers.get("x-request-id") ?? route.requestId,
      method: request.method,
      path: url.pathname,
    });
    return route.handle(request, env);
  },
  queue: handleMetricEventQueue,
} satisfies ExportedHandler<Env, Record<string, unknown>>;

/** The public fetch must stay closed while Evaluation delegates over this binding. */
export class EvaluationEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const identity = delegatedIdentityFor(request, metricEventRoutes);
    if (!identity || new URL(request.url).pathname !== metricEventPath) {
      return notDelegatedResponse(request);
    }
    const credential = await authenticateDelegatedClientKey(identity, this.env);
    if (!credential.ok) return renderError(credential.error);
    return handleAuthorizedMetricEvent(request, this.env, credential.value);
  }
}

const wrappedHandler = wrapWorkerHandler({ fetch: handler.fetch }, { surface: "event-ingest-api" });

export default {
  fetch: wrappedHandler.fetch,
  queue: handler.queue,
} satisfies ExportedHandler<Env, Record<string, unknown>>;

export {
  EvaluationCommitOutboxDurableObject,
  EvaluationUsageReplayWindowDurableObject,
  MetricEventOutboxDurableObject,
  MetricEventRateLimitDurableObject,
};
