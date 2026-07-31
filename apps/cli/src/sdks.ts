import { createMcpOperationAdapter } from "@splitch/control-plane-sdk/mcp-operation-adapter";
import { parsePlatformTarget, type RouteOwner } from "@splitch/contracts";
import { SplitchCliError } from "./errors.js";

const defaultControlPlaneBaseUrl = "http://127.0.0.1:8787";
const defaultEvaluationBaseUrl = "http://127.0.0.1:8788";
const defaultAnalysisBaseUrl = "http://127.0.0.1:8790";
const defaultAuthBaseUrl = "http://127.0.0.1:8789";

// The published binary defaults to hosted production; local development
// opts in with SPLITCH_PLATFORM_TARGET=local. The analysis API has no
// hosted hostname yet, so analysis commands fail loud until one exists.
const defaultPlatformTarget = "production";
const productionOrigins: Readonly<Record<string, string>> = {
  CONTROL_PLANE_API_ORIGIN: "https://api.splitch.dev",
  AUTH_API_ORIGIN: "https://auth.splitch.dev",
  EVALUATION_API_ORIGIN: "https://edge.splitch.dev",
};

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

// Origins resolve lazily per route owner so a command only demands the
// origin it actually routes to (the analysis API has no hosted hostname yet).
export function createOperationSdks(options: SdkFactoryOptions = {}): OperationSdks {
  const platformTarget = parsePlatformTarget(options.platformTarget ?? defaultPlatformTarget);
  const adapter = (envName: string, configured: string | undefined, localDefault: string) =>
    createMcpOperationAdapter({
      baseUrl: apiBaseUrl(envName, configured, localDefault, platformTarget),
      fetch: options.fetch,
    });
  return {
    get "control-plane-api"() {
      return adapter(
        "CONTROL_PLANE_API_ORIGIN",
        options.controlPlaneBaseUrl,
        defaultControlPlaneBaseUrl,
      );
    },
    get "evaluation-api"() {
      return adapter("EVALUATION_API_ORIGIN", options.evaluationBaseUrl, defaultEvaluationBaseUrl);
    },
    get "analysis-api"() {
      return adapter("ANALYSIS_API_ORIGIN", options.analysisBaseUrl, defaultAnalysisBaseUrl);
    },
  };
}

export function sdkForOwner(sdks: OperationSdks, owner: RouteOwner): OperationSdk {
  if (owner === "control-plane-api" || owner === "evaluation-api" || owner === "analysis-api") {
    return sdks[owner as RoutableOwner];
  }
  throw new SplitchCliError({
    code: "CLI_ROUTE_OWNER_UNSUPPORTED",
    causeSummary: `No API origin is configured for route owner "${owner}"`,
    remediation: "Use an operation owned by a CLI-supported API",
  });
}

export function resolveControlPlaneBaseUrl(options: SdkFactoryOptions = {}): string {
  const platformTarget = parsePlatformTarget(options.platformTarget ?? defaultPlatformTarget);
  return apiBaseUrl(
    "CONTROL_PLANE_API_ORIGIN",
    options.controlPlaneBaseUrl,
    defaultControlPlaneBaseUrl,
    platformTarget,
  );
}

export function resolveAuthBaseUrl(options: SdkFactoryOptions = {}): string {
  const platformTarget = parsePlatformTarget(options.platformTarget ?? defaultPlatformTarget);
  return apiBaseUrl("AUTH_API_ORIGIN", options.authBaseUrl, defaultAuthBaseUrl, platformTarget);
}

export function resolveDataPlaneBaseUrl(options: SdkFactoryOptions = {}): string {
  const platformTarget = parsePlatformTarget(options.platformTarget ?? defaultPlatformTarget);
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
  if (platformTarget === "production" && productionOrigins[envName]) {
    return productionOrigins[envName];
  }
  throw new SplitchCliError({
    code: "CLI_API_ORIGIN_MISSING",
    causeSummary: `${envName} is required for ${platformTarget}`,
    remediation: `Set ${envName} to the API origin for ${platformTarget}`,
  });
}
