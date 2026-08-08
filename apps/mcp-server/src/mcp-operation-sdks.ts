import { parsePlatformTarget } from "@splitch/contracts";
import { createMcpOperationAdapter } from "@splitch/control-plane-sdk/mcp-operation-adapter";

/**
 * MCP's one downstream. Every management tool executes through the Control Plane,
 * which runs the membership, Environment-scope, and Policy gates and then
 * delegates to Analysis or Evaluation over its own binding when the registered
 * route says so (ADR-0023/0046).
 *
 * There is deliberately no owner registry here. MCP choosing a downstream by
 * `route.owner` is what let Analysis- and Evaluation-owned tools reach their
 * Worker without the Control Plane's pre-hop D1 gate, so CLI and MCP answered the
 * same operation differently.
 */
export interface McpOperationSdkOptions {
  readonly platformTarget?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly controlPlaneFetch?: typeof fetch;
  readonly controlPlaneDelegationSecret?: string;
}

const defaultControlPlaneBaseUrl = "http://localhost:8787";

export type OperationSdk = ReturnType<typeof createMcpOperationAdapter>;
/** Resolved on first tool call, so protocol methods that call nothing downstream
 * (initialize, tools/list, resources/read) do not demand the origin and secret. */
export type OperationSdkResolver = () => OperationSdk;

export function createControlPlaneOperationSdk(
  options: McpOperationSdkOptions,
): OperationSdkResolver {
  let sdk: OperationSdk | undefined;
  return () => {
    sdk ??= createMcpOperationAdapter({
      baseUrl: controlPlaneBaseUrl(options),
      fetch: requiredControlPlaneFetch(options.controlPlaneFetch),
      delegationSecret: requiredDelegationSecret(options.controlPlaneDelegationSecret),
    });
    return sdk;
  };
}

function requiredDelegationSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error("mcp-server: CONTROL_PLANE_API delegation secret is required");
  }
  return secret;
}

function controlPlaneBaseUrl(options: McpOperationSdkOptions): string {
  if (options.controlPlaneBaseUrl) {
    return options.controlPlaneBaseUrl;
  }
  const platformTarget = parsePlatformTarget(options.platformTarget);
  if (platformTarget === "local" || platformTarget === "pr-ci") {
    return defaultControlPlaneBaseUrl;
  }
  throw new Error(`mcp-server: CONTROL_PLANE_API_ORIGIN is required for ${platformTarget}`);
}

function requiredControlPlaneFetch(requestFetch: typeof fetch | undefined): typeof fetch {
  if (!requestFetch) {
    throw new Error("mcp-server: CONTROL_PLANE_API service binding is required");
  }
  return requestFetch;
}
