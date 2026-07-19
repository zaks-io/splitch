import { expect, test as base, type APIRequestContext } from "@playwright/test";
import {
  requireFullCommitSha,
  verifyHealthObservation,
} from "../../scripts/lib/shared-preview-deployment-evidence.mjs";

export { expect };

interface HealthRoute {
  readonly surface: string;
  readonly service: string;
  readonly url: string;
}

interface JsonRpcEnvelope {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result?: ToolResult;
  readonly error?: { code: number; message: string; data?: unknown };
}

interface ToolResult {
  readonly structuredContent: unknown;
  readonly isError?: boolean;
}

export interface SmokeConfig {
  readonly authBaseUrl: string;
  readonly controlPlaneBaseUrl: string;
  readonly expectedPlatformTarget: string;
  readonly expectedCommitSha: string;
  readonly healthRoutes: readonly HealthRoute[];
  readonly mcpBaseUrl: string;
  readonly runId: string;
  readonly smokeAppId: string;
  readonly smokeClientId: string;
  readonly smokeClientSecret?: string;
  readonly smokeEnvironmentId: string;
  readonly smokeFlagId: string;
  readonly smokeFlagKey: string;
  readonly smokeOrgId: string;
}

interface SmokeFixtures {
  readonly accessToken: string;
  readonly smoke: SmokeClient;
  readonly smokeConfig: SmokeConfig;
}

export const test = base.extend<SmokeFixtures>({
  smokeConfig: async ({ request: _request }, use) => {
    await use(readSmokeConfig());
  },
  smoke: async ({ request, smokeConfig }, use) => {
    await use(new SmokeClient(request, smokeConfig));
  },
  accessToken: async ({ smoke }, use) => {
    await use(await smoke.clientCredentialsToken());
  },
});

class SmokeClient {
  constructor(
    private readonly request: APIRequestContext,
    readonly config: SmokeConfig,
  ) {}

  async assertHealth(route: HealthRoute): Promise<{ body: unknown; route: HealthRoute }> {
    const response = await this.request.get(route.url);
    await expect(response, `${route.surface} health`).toBeOK();
    const body = await response.json();
    verifyHealthObservation({
      body,
      expectedCommitSha: this.config.expectedCommitSha,
      expectedPlatformTarget: this.config.expectedPlatformTarget,
      route,
    });
    return { body, route };
  }

  async authDiscovery(): Promise<Record<string, unknown>> {
    const response = await this.request.get(
      `${this.config.authBaseUrl}/.well-known/oauth-authorization-server`,
    );
    await expect(response, "OAuth discovery").toBeOK();
    return (await response.json()) as Record<string, unknown>;
  }

  async authJwks(): Promise<Record<string, unknown>> {
    const response = await this.request.get(`${this.config.authBaseUrl}/.well-known/jwks.json`);
    await expect(response, "Auth API access-token JWKS").toBeOK();
    return (await response.json()) as Record<string, unknown>;
  }

  async deviceAuthorization(): Promise<Record<string, unknown>> {
    const response = await this.request.post(
      `${this.config.authBaseUrl}/oauth2/device_authorization`,
      { form: {} },
    );
    await expect(response, "WorkOS device authorization").toBeOK();
    return (await response.json()) as Record<string, unknown>;
  }

  async clientCredentialsToken(): Promise<string> {
    if (!this.config.smokeClientSecret) {
      throw new Error("SPLITCH_SMOKE_CLIENT_SECRET is required for shared-preview smoke");
    }
    const response = await this.request.post(`${this.config.authBaseUrl}/oauth2/token`, {
      form: {
        grant_type: "client_credentials",
        client_id: this.config.smokeClientId,
        client_secret: this.config.smokeClientSecret,
      },
    });
    await expect(response, "smoke client_credentials token").toBeOK();
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.token_type).toBe("Bearer");
    expect(typeof body.access_token).toBe("string");
    expect(String(body.access_token).split(".")).toHaveLength(3);
    expect(body.expires_in).toEqual(expect.any(Number));
    return String(body.access_token);
  }

  async assertFixtureTurnstileRejected(): Promise<Record<string, unknown>> {
    const response = await this.request.post(`${this.config.authBaseUrl}/agent/identity`, {
      data: { turnstile_token: `fixture-turnstile-ok-${this.config.runId}` },
    });
    expect(response.status(), "fixture Turnstile token rejection").toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "access_denied" });
    return body;
  }

  async listTools(): Promise<Record<string, unknown>[]> {
    const envelope = await this.mcpRequest({
      jsonrpc: "2.0",
      id: "tools-list-smoke",
      method: "tools/list",
    });
    expect(envelope.error, "tools/list error").toBeUndefined();
    expect(envelope.result, "tools/list result").toBeDefined();
    const tools = envelope.result?.structuredContent ?? envelope.result;
    const list = (tools as { tools?: unknown[] }).tools;
    expect(Array.isArray(list)).toBe(true);
    return list as Record<string, unknown>[];
  }

  async callTool<T>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.callToolResult(token, name, args);
    expectNoRateLimited(result);
    if (result.isError) {
      throw new Error(`MCP ${name} returned ${JSON.stringify(result.structuredContent)}`);
    }
    return result.structuredContent as T;
  }

  async callToolError(
    name: string,
    args: Record<string, unknown>,
    token?: string,
  ): Promise<unknown> {
    const result = await this.callToolResult(token, name, args);
    expect(result.isError).toBe(true);
    expectNoRateLimited(result);
    return result.structuredContent;
  }

  async controlPlaneGet<T>(token: string, path: string): Promise<T> {
    const response = await this.request.get(`${this.config.controlPlaneBaseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(response, `Control Plane GET ${path}`).toBeOK();
    return (await response.json()) as T;
  }

  uniqueKey(prefix: string): string {
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${this.config.runId}-${suffix}`.toLowerCase();
  }

  private async callToolResult(
    token: string | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const envelope = await this.mcpRequest(
      {
        jsonrpc: "2.0",
        id: `${name}-smoke`,
        method: "tools/call",
        params: { name, arguments: args },
      },
      token,
    );
    expect(envelope.error).toBeUndefined();
    expect(envelope.result).toBeDefined();
    return envelope.result as ToolResult;
  }

  private async mcpRequest(
    body: Record<string, unknown>,
    token?: string,
  ): Promise<JsonRpcEnvelope> {
    const response = await this.request.post(`${this.config.mcpBaseUrl}/mcp`, {
      data: body,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    await expect(response, "MCP JSON-RPC").toBeOK();
    const envelope = (await response.json()) as JsonRpcEnvelope;
    expect(envelope.jsonrpc).toBe("2.0");
    return envelope;
  }
}

function expectNoRateLimited(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain("RATE_LIMITED");
}

function readSmokeConfig(): SmokeConfig {
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
    runId: runId(),
    smokeAppId: process.env.SPLITCH_SMOKE_APP_ID ?? "app_shared_preview_smoke",
    smokeClientId: process.env.SPLITCH_SMOKE_CLIENT_ID ?? "splitch-shared-preview-smoke",
    smokeClientSecret: process.env.SPLITCH_SMOKE_CLIENT_SECRET,
    smokeEnvironmentId: process.env.SPLITCH_SMOKE_ENVIRONMENT_ID ?? "env_shared_preview_smoke_dev",
    smokeFlagId: process.env.SPLITCH_SMOKE_FLAG_ID ?? "flag_shared_preview_smoke",
    smokeFlagKey: process.env.SPLITCH_SMOKE_FLAG_KEY ?? "shared-preview-smoke",
    smokeOrgId: process.env.SPLITCH_SMOKE_ORG_ID ?? "org_shared_preview_smoke",
  };
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
