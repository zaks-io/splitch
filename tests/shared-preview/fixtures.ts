import { expect, test as base, type APIRequestContext, type APIResponse } from "@playwright/test";
import { verifyHealthObservation } from "../../scripts/lib/shared-preview-deployment-evidence.mjs";
import { type HealthRoute, readSmokeConfig, type SmokeConfig } from "./smoke-config";

export { expect };
export type { SmokeConfig };

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

interface SmokeFixtures {
  readonly accessToken: string;
  readonly controlPlaneAccessToken: string;
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
    await use(await smoke.mcpClientCredentialsToken());
  },
  controlPlaneAccessToken: async ({ smoke }, use) => {
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

  async clientCredentialsToken(resource?: string): Promise<string> {
    if (!this.config.smokeClientSecret) {
      throw new Error("SPLITCH_SMOKE_CLIENT_SECRET is required for shared-preview smoke");
    }
    const response = await this.request.post(`${this.config.authBaseUrl}/oauth2/token`, {
      form: {
        grant_type: "client_credentials",
        client_id: this.config.smokeClientId,
        client_secret: this.config.smokeClientSecret,
        ...(resource ? { resource } : {}),
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

  async mcpClientCredentialsToken(): Promise<string> {
    return this.clientCredentialsToken(this.config.mcpProtectedResource);
  }

  async mcpProtectedResourceMetadata(): Promise<Record<string, unknown>> {
    const response = await this.request.get(
      `${this.config.mcpBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    await expect(response, "MCP protected-resource metadata").toBeOK();
    return (await response.json()) as Record<string, unknown>;
  }

  async mcpUnauthorizedConnect(): Promise<APIResponse> {
    return this.request.post(`${this.config.mcpBaseUrl}/mcp`, {
      data: { jsonrpc: "2.0", id: "connect-smoke", method: "initialize", params: {} },
    });
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

  async listTools(token: string): Promise<Record<string, unknown>[]> {
    const envelope = await this.mcpRequest(
      {
        jsonrpc: "2.0",
        id: "tools-list-smoke",
        method: "tools/list",
      },
      token,
    );
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

  async callToolUnauthorized(name: string, args: Record<string, unknown>): Promise<APIResponse> {
    return this.request.post(`${this.config.mcpBaseUrl}/mcp`, {
      data: {
        jsonrpc: "2.0",
        id: `${name}-unauthorized-smoke`,
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
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
