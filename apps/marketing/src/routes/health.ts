import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

const service = "splitch-marketing";
const workerEnv = env as {
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          createHealthResponse(
            service,
            parsePlatformTarget(workerEnv.SPLITCH_PLATFORM_TARGET),
            workerEnv.SPLITCH_DEPLOYED_COMMIT_SHA,
          ),
        ),
    },
  },
});
