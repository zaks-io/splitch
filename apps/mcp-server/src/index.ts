import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import { handleMcpServerRequest } from "./mcp-handler";
import { McpSessionDurableObject } from "./mcp-session-do";
import { durableMcpSessionStore, type McpSessionDurableObjectNamespace } from "./mcp-session-store";

const service = "splitch-mcp-server";

type Env = {
  ANALYSIS_API?: Fetcher;
  AUTH_API_ORIGIN?: string;
  CONTROL_PLANE_API_ORIGIN?: string;
  EVALUATION_API_ORIGIN?: string;
  ANALYSIS_API_ORIGIN?: string;
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SENTRY_DSN?: string;
  MCP_SESSIONS: McpSessionDurableObjectNamespace;
};

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const observability = createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("mcp-server", ctx),
    );
    const url = new URL(request.url);
    observability.onRequest?.({
      requestId: request.headers.get("x-request-id") ?? "mcp-request",
      method: request.method,
      path: url.pathname,
    });
    return handleMcpServerRequest({
      request,
      service,
      deployedCommitSha: env.SPLITCH_DEPLOYED_COMMIT_SHA,
      platformTarget: env.SPLITCH_PLATFORM_TARGET,
      authBaseUrl: env.AUTH_API_ORIGIN,
      controlPlaneBaseUrl: env.CONTROL_PLANE_API_ORIGIN,
      evaluationBaseUrl: env.EVALUATION_API_ORIGIN,
      analysisBaseUrl: env.ANALYSIS_API_ORIGIN,
      analysisFetch: serviceBindingFetch(env.ANALYSIS_API),
      sessionStore: durableMcpSessionStore(env.MCP_SESSIONS),
    });
  },
} satisfies ExportedHandler<Env>;

export default wrapWorkerHandler(handler, { surface: "mcp-server" });

export { handleMcpServerRequest, McpSessionDurableObject };

function serviceBindingFetch(service: Fetcher | undefined): typeof fetch | undefined {
  if (!service) {
    return undefined;
  }

  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return service.fetch(request);
  };
}
