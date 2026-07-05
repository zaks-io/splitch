import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

const service = "splitch-control-panel";
const workerEnv = env as { SPLITCH_PLATFORM_TARGET?: string };

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          createHealthResponse(service, parsePlatformTarget(workerEnv.SPLITCH_PLATFORM_TARGET)),
        ),
    },
  },
});
