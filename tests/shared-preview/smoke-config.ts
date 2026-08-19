import { requireFullCommitSha } from "../../scripts/lib/shared-preview-deployment-evidence.mjs";

export interface HealthRoute {
  readonly surface: string;
  readonly service: string;
  readonly url: string;
}

export interface SmokeConfig {
  readonly authBaseUrl: string;
  readonly controlPlaneBaseUrl: string;
  readonly expectedPlatformTarget: string;
  readonly expectedCommitSha: string;
  readonly healthRoutes: readonly HealthRoute[];
  readonly mcpBaseUrl: string;
  readonly mcpProtectedResource: string;
  readonly panelBaseUrl: string;
  readonly runId: string;
  readonly smokeAppId: string;
  readonly smokeClientId: string;
  readonly smokeClientSecret?: string;
  readonly smokeEnvironmentId: string;
  readonly smokeFlagId: string;
  readonly smokeFlagKey: string;
  readonly smokeOrgId: string;
  readonly smokeOrgSlug: string;
}

export interface PanelCredentials {
  readonly email: string;
  readonly password: string;
}

export function readSmokeConfig(): SmokeConfig {
  const authBaseUrl = originUrl("SPLITCH_SMOKE_AUTH_BASE_URL", "https://auth.preview.splitch.dev");
  const mcpBaseUrl = originUrl("SPLITCH_SMOKE_MCP_BASE_URL", "https://mcp.preview.splitch.dev");
  return {
    authBaseUrl,
    controlPlaneBaseUrl: originUrl(
      "SPLITCH_SMOKE_CONTROL_PLANE_BASE_URL",
      "https://api.preview.splitch.dev",
    ),
    expectedPlatformTarget: "shared-preview",
    expectedCommitSha: requireFullCommitSha(
      process.env.SPLITCH_SMOKE_COMMIT_SHA ?? process.env.SPLITCH_DEPLOYED_COMMIT_SHA,
      "SPLITCH_SMOKE_COMMIT_SHA",
    ),
    healthRoutes: healthRoutes(),
    mcpBaseUrl,
    mcpProtectedResource: `${mcpBaseUrl}/mcp`,
    panelBaseUrl: originUrl("SPLITCH_SMOKE_PANEL_BASE_URL", "https://app.preview.splitch.dev"),
    runId: runId(),
    smokeAppId: process.env.SPLITCH_SMOKE_APP_ID ?? "app_shared_preview_smoke",
    smokeClientId: process.env.SPLITCH_SMOKE_CLIENT_ID ?? "splitch-shared-preview-smoke",
    smokeClientSecret: process.env.SPLITCH_SMOKE_CLIENT_SECRET,
    smokeEnvironmentId: process.env.SPLITCH_SMOKE_ENVIRONMENT_ID ?? "env_shared_preview_smoke_dev",
    smokeFlagId: process.env.SPLITCH_SMOKE_FLAG_ID ?? "flag_shared_preview_smoke",
    smokeFlagKey: process.env.SPLITCH_SMOKE_FLAG_KEY ?? "shared-preview-smoke",
    smokeOrgId: process.env.SPLITCH_SMOKE_ORG_ID ?? "org_shared_preview_smoke",
    smokeOrgSlug: process.env.SPLITCH_SMOKE_ORG_SLUG ?? "org_shared_preview_smoke",
  };
}

/**
 * The panel smoke login is provisioned per run by `shared-preview:seed-panel-user`.
 * Missing credentials mean that step did not run, which must fail the smoke rather than
 * quietly degrade it to a signed-out crawl.
 */
export function readPanelCredentials(): PanelCredentials {
  const email = process.env.SPLITCH_SMOKE_PANEL_EMAIL;
  const password = process.env.SPLITCH_SMOKE_PANEL_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "SPLITCH_SMOKE_PANEL_EMAIL and SPLITCH_SMOKE_PANEL_PASSWORD are required for the " +
        "Control Panel hosted smoke. Run `pnpm shared-preview:seed-panel-user` first; it " +
        "provisions the AuthKit account and exports both.",
    );
  }
  return { email, password };
}

function healthRoutes(): HealthRoute[] {
  return [
    route("Marketing", "splitch-marketing", "MARKETING", "preview.splitch.dev"),
    route("Control Panel", "splitch-control-panel", "CONTROL_PANEL", "app.preview.splitch.dev"),
    route(
      "Control Plane API",
      "splitch-control-plane-api",
      "CONTROL_PLANE_API",
      "api.preview.splitch.dev",
    ),
    route("Auth API", "splitch-auth-api", "AUTH_API", "auth.preview.splitch.dev"),
    route("Evaluation API", "splitch-evaluation-api", "EVALUATION_API", "edge.preview.splitch.dev"),
    route(
      "Event Ingest API",
      "splitch-event-ingest-api",
      "EVENT_INGEST_API",
      "ingest.preview.splitch.dev",
    ),
    route("MCP", "splitch-mcp-server", "MCP", "mcp.preview.splitch.dev"),
  ];
}

function route(surface: string, service: string, envSuffix: string, host: string): HealthRoute {
  return {
    surface,
    service,
    url: envUrl(`SPLITCH_SMOKE_${envSuffix}_URL`, `https://${host}/health`),
  };
}

function envUrl(name: string, fallback: string): string {
  return new URL(process.env[name] ?? fallback).toString();
}

function originUrl(name: string, fallback: string): string {
  return new URL(process.env[name] ?? fallback).origin;
}

function runId(): string {
  const raw = process.env.SPLITCH_SMOKE_RUN_ID ?? process.env.GITHUB_RUN_ID ?? String(Date.now());
  return raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .slice(0, 32);
}
