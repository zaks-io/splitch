import { env } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createFileRoute } from "@tanstack/react-router";

const service = "splitch-control-panel";
const workerEnv = env as {
  SPLITCH_LOCAL_E2E_RUN_ID?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async () => {
        const response = Response.json(
          createHealthResponse(service, parsePlatformTarget(workerEnv.SPLITCH_PLATFORM_TARGET)),
        );
        if (workerEnv.SPLITCH_LOCAL_E2E_RUN_ID) {
          response.headers.set("x-splitch-local-e2e-run-id", workerEnv.SPLITCH_LOCAL_E2E_RUN_ID);
        }
        return response;
      },
    },
  },
});
