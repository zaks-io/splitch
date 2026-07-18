import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import { handleEvaluationIngest, handleIngest } from "./ingest";
import { EvaluationUsageReplayWindowDurableObject } from "./evaluation-usage-replay-window";
import type { Env } from "./types";

const service = "splitch-event-ingest-api";
const ingestPath = "/api/internal/exposures";
const evaluationIngestPath = "/api/internal/evaluations";

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const observability = createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("event-ingest-api", ctx),
    );

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json(
        createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      );
    }

    if (request.method === "POST" && url.pathname === ingestPath) {
      observability.onRequest?.({
        requestId: request.headers.get("x-request-id") ?? "ingest-request",
        method: request.method,
        path: url.pathname,
      });
      return handleIngest(request, env);
    }

    if (request.method === "POST" && url.pathname === evaluationIngestPath) {
      observability.onRequest?.({
        requestId: request.headers.get("x-request-id") ?? "evaluation-ingest-request",
        method: request.method,
        path: url.pathname,
      });
      return handleEvaluationIngest(request, env);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export default wrapWorkerHandler(handler, { surface: "event-ingest-api" });

export { EvaluationUsageReplayWindowDurableObject };
