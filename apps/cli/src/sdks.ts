import {
  createMcpOperationAdapter,
  type PlatformTarget,
  PlatformTargetSchema,
  type PublicSurface,
  platformTargets,
  publicSurfaceFor,
  type RouteContract,
} from "@splitch/sdk/control-plane";
import { SplitchCliError } from "./errors.js";

const defaultControlPlaneBaseUrl = "http://127.0.0.1:8787";
const defaultEvaluationBaseUrl = "http://127.0.0.1:8788";
const defaultAuthBaseUrl = "http://127.0.0.1:8789";

// The published binary defaults to hosted production; local development
// opts in with SPLITCH_PLATFORM_TARGET=local. Every hosted origin here is
// fixed by ADR-0038's subdomain map -- the CLI reads that table, it does not
// invent hostnames.
const defaultPlatformTarget: PlatformTarget = "production";
const productionOrigins: Readonly<Record<string, string>> = {
  CONTROL_PLANE_API_ORIGIN: "https://api.splitch.dev",
  AUTH_API_ORIGIN: "https://auth.splitch.dev",
  EVALUATION_API_ORIGIN: "https://edge.splitch.dev",
};

export type OperationSdk = ReturnType<typeof createMcpOperationAdapter>;
export type OperationSdks = Record<PublicSurface, OperationSdk>;

export interface SdkFactoryOptions {
  readonly platformTarget?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly evaluationBaseUrl?: string;
  readonly authBaseUrl?: string;
  readonly fetch?: typeof fetch;
}

// The contracts parsePlatformTarget helper silently falls back to "local";
// in a published binary that would route an env-var typo to localhost, so
// the CLI validates strictly instead (ADR-0036 fail-loud).
function requirePlatformTarget(value: string | undefined): PlatformTarget {
  if (value === undefined) {
    return defaultPlatformTarget;
  }
  const parsed = PlatformTargetSchema.safeParse(value);
  if (!parsed.success) {
    throw new SplitchCliError({
      code: "CLI_VALIDATION_ERROR",
      causeSummary: `SPLITCH_PLATFORM_TARGET "${value}" is not a platform target`,
      remediation: `Use one of: ${platformTargets.join(", ")}`,
    });
  }
  return parsed.data;
}

// Origins resolve lazily per public surface so a command only demands the
// origin it actually routes to.
export function createOperationSdks(options: SdkFactoryOptions = {}): OperationSdks {
  const platformTarget = requirePlatformTarget(options.platformTarget);
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
  };
}

/**
 * Which origin a client sends an operation to is a property of the credential
 * the operation takes, not of the Worker that executes it (ADR-0046). A
 * control-plane-token route is addressed at the control-plane origin even when
 * another Worker implements it; `route.owner` is the internal delegation target
 * and never reaches a client.
 */
export function sdkForRoute(
  sdks: OperationSdks,
  route: Pick<RouteContract, "id" | "auth">,
): OperationSdk {
  return sdks[requirePublicSurface(route)];
}

function requirePublicSurface(route: Pick<RouteContract, "id" | "auth">): PublicSurface {
  const surface = publicSurfaceFor(route);
  if (surface === null) {
    // A binding-only route reached a client command: no origin exists to send it
    // to, so fail here rather than defaulting to a surface that would reject it.
    throw new SplitchCliError({
      code: "CLI_ROUTE_SURFACE_UNSUPPORTED",
      causeSummary: `The operation ${route.id} has no public origin the CLI can address`,
      remediation: "Use an operation exposed on a public API surface",
    });
  }
  return surface;
}

export function resolveControlPlaneBaseUrl(options: SdkFactoryOptions = {}): string {
  const platformTarget = requirePlatformTarget(options.platformTarget);
  return apiBaseUrl(
    "CONTROL_PLANE_API_ORIGIN",
    options.controlPlaneBaseUrl,
    defaultControlPlaneBaseUrl,
    platformTarget,
  );
}

export function resolveAuthBaseUrl(options: SdkFactoryOptions = {}): string {
  const platformTarget = requirePlatformTarget(options.platformTarget);
  return apiBaseUrl("AUTH_API_ORIGIN", options.authBaseUrl, defaultAuthBaseUrl, platformTarget);
}

/**
 * Hosted targets must open HTTPS device-approval URLs only. Local HTTP is
 * allowed solely for the explicit `local` and `pr-ci` loopback targets.
 */
export function authOriginRequiresHttps(options: SdkFactoryOptions = {}): boolean {
  const platformTarget = requirePlatformTarget(options.platformTarget);
  return platformTarget === "shared-preview" || platformTarget === "production";
}

export function resolveDataPlaneBaseUrl(options: SdkFactoryOptions = {}): string {
  const platformTarget = requirePlatformTarget(options.platformTarget);
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
