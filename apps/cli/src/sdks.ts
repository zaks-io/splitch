import { createMcpOperationAdapter } from "@splitch/control-plane-sdk/mcp-operation-adapter";
import { parsePlatformTarget, type RouteOwner } from "@splitch/contracts";

const defaultControlPlaneBaseUrl = "http://127.0.0.1:8787";
const defaultEvaluationBaseUrl = "http://127.0.0.1:8788";
const defaultAnalysisBaseUrl = "http://127.0.0.1:8790";
const defaultAuthBaseUrl = "http://127.0.0.1:8789";

type RoutableOwner = "control-plane-api" | "evaluation-api" | "analysis-api";
export type OperationSdk = ReturnType<typeof createMcpOperationAdapter>;
export type OperationSdks = Record<RoutableOwner, OperationSdk>;

export interface SdkFactoryOptions {
  readonly platformTarget?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly evaluationBaseUrl?: string;
  readonly analysisBaseUrl?: string;
  readonly authBaseUrl?: string;
  readonly fetch?: typeof fetch;
}

export function createOperationSdks(options: SdkFactoryOptions = {}): OperationSdks {
  const platformTarget = parsePlatformTarget(options.platformTarget ?? "local");
  return {
    "control-plane-api": createMcpOperationAdapter({
      baseUrl: apiBaseUrl(
        "CONTROL_PLANE_API_ORIGIN",
        options.controlPlaneBaseUrl,
        defaultControlPlaneBaseUrl,
        platformTarget,
      ),
      fetch: options.fetch,
    }),
    "evaluation-api": createMcpOperationAdapter({
      baseUrl: apiBaseUrl(
        "EVALUATION_API_ORIGIN",
        options.evaluationBaseUrl,
        defaultEvaluationBaseUrl,
        platformTarget,
      ),
      fetch: options.fetch,
    }),
    "analysis-api": createMcpOperationAdapter({
      baseUrl: apiBaseUrl(
        "ANALYSIS_API_ORIGIN",
        options.analysisBaseUrl,
        defaultAnalysisBaseUrl,
        platformTarget,
      ),
      fetch: options.fetch,
    }),
  };
}

export function sdkForOwner(sdks: OperationSdks, owner: RouteOwner): OperationSdk {
  if (owner === "control-plane-api" || owner === "evaluation-api" || owner === "analysis-api") {
    return sdks[owner as RoutableOwner];
  }
  throw new Error(`splitch cli: no API origin configured for route owner "${owner}"`);
}

export function resolveAuthBaseUrl(options: SdkFactoryOptions = {}): string {
  const platformTarget = parsePlatformTarget(options.platformTarget ?? "local");
  return apiBaseUrl("AUTH_API_ORIGIN", options.authBaseUrl, defaultAuthBaseUrl, platformTarget);
}

export function resolveDataPlaneBaseUrl(options: SdkFactoryOptions = {}): string {
  const platformTarget = parsePlatformTarget(options.platformTarget ?? "local");
  return apiBaseUrl(
    "EVALUATION_API_ORIGIN",
    options.evaluationBaseUrl,
    defaultEvaluationBaseUrl,
    platformTarget,
  );
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
  throw new Error(`splitch cli: ${envName} is required for ${platformTarget}`);
}
