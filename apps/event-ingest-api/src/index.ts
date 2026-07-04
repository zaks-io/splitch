import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createWorkerObservability, wrapWorkerHandler } from "@splitch/observability/worker";
import { handleIngest } from "./ingest";
import type { Env } from "./types";

const service = "splitch-event-ingest-api";
const ingestPath = "/api/internal/exposures";

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const observability = createWorkerObservability(env, { surface: "event-ingest-api" });

    if (request.method === "GET" && url.pathname === "/") {
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
      return handleIngest(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export default wrapWorkerHandler(handler, { surface: "event-ingest-api" });
