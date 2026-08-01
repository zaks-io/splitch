import { parsePlatformTarget } from "@splitch/contracts";
import { createMcpOperationAdapter } from "@splitch/control-plane-sdk/mcp-operation-adapter";

export interface McpOperationSdkOptions {
  readonly platformTarget?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly evaluationBaseUrl?: string;
  readonly analysisBaseUrl?: string;
  readonly controlPlaneFetch?: typeof fetch;
  readonly evaluationFetch?: typeof fetch;
  readonly analysisFetch?: typeof fetch;
  readonly controlPlaneDelegationSecret?: string;
  readonly evaluationDelegationSecret?: string;
  readonly analysisDelegationSecret?: string;
}

const defaultControlPlaneBaseUrl = "http://localhost:8787";
const defaultEvaluationBaseUrl = "http://127.0.0.1:8788";
const defaultAnalysisBaseUrl = "http://127.0.0.1:8790";
const internalAnalysisBaseUrl = "https://analysis-api.internal";

type McpRoutableOwner = "control-plane-api" | "evaluation-api" | "analysis-api";
type OperationSdk = ReturnType<typeof createMcpOperationAdapter>;
type OperationSdkResolver = () => OperationSdk;
export type OperationSdks = Record<McpRoutableOwner, OperationSdkResolver>;

export function createOperationSdks(options: McpOperationSdkOptions): OperationSdks {
  const platformTarget = parsePlatformTarget(options.platformTarget);
  return {
    "control-plane-api": createLazyOperationSdk(() =>
      createMcpOperationAdapter({
        baseUrl: apiBaseUrl(
          "CONTROL_PLANE_API_ORIGIN",
          options.controlPlaneBaseUrl,
          defaultControlPlaneBaseUrl,
          platformTarget,
        ),
        fetch: downstreamFetch("CONTROL_PLANE_API", options.controlPlaneFetch),
        delegationSecret: requiredDelegationSecret(
          "CONTROL_PLANE_API",
          options.controlPlaneDelegationSecret,
        ),
      }),
    ),
    "evaluation-api": createLazyOperationSdk(() =>
      createMcpOperationAdapter({
        baseUrl: apiBaseUrl(
          "EVALUATION_API_ORIGIN",
          options.evaluationBaseUrl,
          defaultEvaluationBaseUrl,
          platformTarget,
        ),
        fetch: downstreamFetch("EVALUATION_API", options.evaluationFetch),
        delegationSecret: requiredDelegationSecret(
          "EVALUATION_API",
          options.evaluationDelegationSecret,
        ),
      }),
    ),
    "analysis-api": createLazyOperationSdk(() =>
      createMcpOperationAdapter({
        baseUrl: analysisApiBaseUrl(options.analysisBaseUrl, platformTarget),
        fetch: downstreamFetch("ANALYSIS_API", options.analysisFetch),
        delegationSecret: requiredDelegationSecret(
          "ANALYSIS_API",
          options.analysisDelegationSecret,
        ),
      }),
    ),
  };
}

function requiredDelegationSecret(bindingName: string, secret: string | undefined): string {
  if (!secret) throw new Error(`mcp-server: ${bindingName} delegation secret is required`);
  return secret;
}

function createLazyOperationSdk(createSdk: () => OperationSdk): OperationSdkResolver {
  let sdk: OperationSdk | undefined;
  return () => {
    sdk ??= createSdk();
    return sdk;
  };
}

/**
 * The one origin with no `*_API_ORIGIN` env behind it, deliberately: Analysis has
 * no public hostname (ADR-0046), so hosted targets address it only through the
 * service binding, and the URL exists just to carry the path. An env override
 * would be a way to point this at something reachable, which is the bug.
 */
function analysisApiBaseUrl(configured: string | undefined, platformTarget: string): string {
  if (configured) {
    return configured;
  }
  if (platformTarget === "local" || platformTarget === "pr-ci") {
    return defaultAnalysisBaseUrl;
  }
  return internalAnalysisBaseUrl;
}

function apiBaseUrl(
  envName: string,
  configured: string | undefined,
  localDefault: string,
  platformTarget: string,
): string {
  if (configured) {
    return configured;
  }
  if (platformTarget === "local" || platformTarget === "pr-ci") {
    return localDefault;
  }
  throw new Error(`mcp-server: ${envName} is required for ${platformTarget}`);
}

function downstreamFetch(
  bindingName: string,
  requestFetch: typeof fetch | undefined,
): typeof fetch {
  if (!requestFetch) throw new Error(`mcp-server: ${bindingName} service binding is required`);
  return requestFetch;
}
