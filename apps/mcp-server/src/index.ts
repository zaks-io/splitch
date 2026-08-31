import { accessTokenRevocationKey } from "@splitch/contracts";
import { createMcpSpanRecorder } from "@splitch/observability/mcp-spans";
import {
  activeTraceId,
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import { mcpFaultReporter } from "./mcp-fault";
import { handleMcpServerRequest } from "./mcp-handler";
import { McpSessionDurableObject } from "./mcp-session-do";
import { durableMcpSessionStore, type McpSessionDurableObjectNamespace } from "./mcp-session-store";

const service = "splitch-mcp-server";

/**
 * One internal downstream, by design: MCP carries no Analysis or Evaluation
 * binding and no owner registry, so every management tool passes the Control
 * Plane's gates before anything is delegated onward (ADR-0023/0046).
 */
type Env = {
  CONTROL_PLANE_API?: Fetcher;
  AUTH_API_ORIGIN?: string;
  MCP_OAUTH_AUTHORIZATION_SERVER?: string;
  CONTROL_PLANE_API_ORIGIN?: string;
  MCP_CONTROL_PLANE_DELEGATION_SECRET?: string;
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  SENTRY_DSN?: string;
  SESSION_STORE?: KVNamespace;
  MCP_SESSIONS: McpSessionDurableObjectNamespace;
};

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const observability = createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("mcp-server", ctx),
    );
    const url = new URL(request.url);
    // Resolved once here, inside the request transaction `wrapWorkerHandler`
    // opened, so the whole request shares one reference. Also the fallback for
    // `x-request-id`: the literal that used to sit there made every untagged
    // request indistinguishable in the logs, which is most of them.
    const traceId = await activeTraceId(env);
    observability.onRequest?.({
      requestId: request.headers.get("x-request-id") ?? traceId ?? "mcp-request",
      method: request.method,
      path: url.pathname,
    });
    return handleMcpServerRequest({
      request,
      service,
      deployedCommitSha: env.SPLITCH_DEPLOYED_COMMIT_SHA,
      platformTarget: env.SPLITCH_PLATFORM_TARGET,
      authBaseUrl: env.AUTH_API_ORIGIN,
      oauthAuthorizationServer: env.MCP_OAUTH_AUTHORIZATION_SERVER,
      oauthJwksUrl: env.MCP_OAUTH_AUTHORIZATION_SERVER
        ? `${new URL(env.MCP_OAUTH_AUTHORIZATION_SERVER).origin}/oauth2/jwks`
        : undefined,
      controlPlaneBaseUrl: env.CONTROL_PLANE_API_ORIGIN,
      controlPlaneFetch: serviceBindingFetch(env.CONTROL_PLANE_API),
      controlPlaneDelegationSecret: env.MCP_CONTROL_PLANE_DELEGATION_SECRET,
      revocations: kvRevocations(requiredSessionStore(env.SESSION_STORE)),
      sessionStore: durableMcpSessionStore(env.MCP_SESSIONS),
      spans: createMcpSpanRecorder(env),
      reportFault: mcpFaultReporter(observability, traceId),
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

function requiredSessionStore(store: KVNamespace | undefined): KVNamespace {
  if (!store) throw new Error("mcp-server: SESSION_STORE revocation binding is required");
  return store;
}

function kvRevocations(store: KVNamespace) {
  return {
    async isRevoked(subject: string) {
      return (await store.get(accessTokenRevocationKey(subject))) !== null;
    },
  };
}
