import { handleMcpServerRequest } from "./mcp-handler.js";
import { createWorkerObservability, wrapWorkerHandler } from "@splitch/observability/worker";

const service = "splitch-mcp-server";

type Env = {
  CONTROL_PLANE_API_ORIGIN?: string;
  EVALUATION_API_ORIGIN?: string;
  ANALYSIS_API_ORIGIN?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SENTRY_DSN?: string;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
};

const handler = {
  async fetch(request, env): Promise<Response> {
    const observability = createWorkerObservability(env, { surface: "mcp-server" });
    const url = new URL(request.url);
    observability.onRequest?.({
      requestId: request.headers.get("x-request-id") ?? "mcp-request",
      method: request.method,
      path: url.pathname,
    });
    return handleMcpServerRequest({
      request,
      service,
      platformTarget: env.SPLITCH_PLATFORM_TARGET,
      controlPlaneBaseUrl: env.CONTROL_PLANE_API_ORIGIN,
      evaluationBaseUrl: env.EVALUATION_API_ORIGIN,
      analysisBaseUrl: env.ANALYSIS_API_ORIGIN,
    });
  },
} satisfies ExportedHandler<Env>;

export default wrapWorkerHandler(handler, { surface: "mcp-server" });

export { handleMcpServerRequest };
