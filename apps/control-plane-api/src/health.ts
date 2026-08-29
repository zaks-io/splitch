import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import type { ControlPlaneApiEnv } from "./env";

const service = "splitch-control-plane-api";

export function controlPlaneHealthResponse(env: ControlPlaneApiEnv): Response {
  const response = Response.json(
    createHealthResponse(
      service,
      parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
      env.SPLITCH_DEPLOYED_COMMIT_SHA,
    ),
  );
  if (env.SPLITCH_LOCAL_E2E_RUN_ID) {
    response.headers.set("x-splitch-local-e2e-run-id", env.SPLITCH_LOCAL_E2E_RUN_ID);
  }
  return response;
}
