import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import { handleEvaluationCommit } from "./evaluation-commit";
import { EvaluationCommitOutboxDurableObject } from "./evaluation-commit-outbox";
import { EvaluationUsageReplayWindowDurableObject } from "./evaluation-usage-replay-window";
import { handleEvaluationIngest, handleIngest } from "./ingest";
import { handleMetricEvent } from "./metric-event-ingest";
import { MetricEventOutboxDurableObject } from "./metric-event-outbox";
import { MetricEventRateLimitDurableObject } from "./metric-event-rate-limit";
import { appendRawEvent, tinybirdDelivery } from "./tinybird";
import type { Env } from "./types";

const service = "splitch-event-ingest-api";
const ingestPath = "/api/internal/exposures";
const evaluationIngestPath = "/api/internal/evaluations";
const evaluationCommitPath = "/api/internal/evaluation-commits";
const metricEventPath = "/api/sdk/events";

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

    if (request.method === "POST" && url.pathname === metricEventPath) {
      return handleMetricEvent(request, env);
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
  async queue(batch, env): Promise<void> {
    const delivery = tinybirdDelivery(env, "metric_events");
    if (!delivery.ok) throw new Error(delivery.error.message);
    await Promise.all(
      batch.messages.map((message) =>
        appendRawEvent(message.body as Record<string, unknown>, delivery.value),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

export default wrapWorkerHandler(handler, { surface: "event-ingest-api" });

export {
  EvaluationCommitOutboxDurableObject,
  EvaluationUsageReplayWindowDurableObject,
  MetricEventOutboxDurableObject,
  MetricEventRateLimitDurableObject,
};
