import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { handleIngest } from "./ingest";
import type { Env } from "./types";

const service = "splitch-event-ingest-api";
const ingestPath = "/api/internal/exposures";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json(
        createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
      );
    }

    if (request.method === "POST" && url.pathname === ingestPath) {
      return handleIngest(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
