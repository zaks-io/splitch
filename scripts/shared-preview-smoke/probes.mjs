export function createProbePlan(config) {
  let smokeAccessToken;

  async function fetchWithTimeout(url, init = {}) {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  }

  async function assertHealth(route) {
    const response = await fetchWithTimeout(route.url);
    assertStatus(response, 200);
    const body = await response.json();
    assertEqual(body.ok, true, "ok");
    assertEqual(body.service, route.service, "service");
    assertEqual(body.platformTarget, config.expectedPlatformTarget, "platformTarget");
    return `${route.service} ${body.platformTarget}`;
  }

  async function assertAuthDiscovery() {
    const url = `${config.authBaseUrl}/.well-known/oauth-authorization-server`;
    const response = await fetchWithTimeout(url);
    assertStatus(response, 200);
    const body = await response.json();
    assertEqual(body.issuer, config.authBaseUrl, "issuer");
    assertEqual(body.token_endpoint, `${config.authBaseUrl}/oauth2/token`, "token_endpoint");
    assertEqual(
      body.device_authorization_endpoint,
      `${config.authBaseUrl}/oauth2/device_authorization`,
      "device_authorization_endpoint",
    );
    if (!body.agent_auth?.identity_types_supported?.includes("device_flow")) {
      throw new Error("agent_auth.identity_types_supported did not include device_flow");
    }
    if (!body.grant_types_supported?.includes("client_credentials")) {
      throw new Error("grant_types_supported did not include client_credentials");
    }
    return "oauth metadata includes device_flow and client_credentials";
  }

  async function assertDeviceAuthorization() {
    const response = await fetchWithTimeout(`${config.authBaseUrl}/oauth2/device_authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(),
    });
    assertStatus(response, 200);
    const body = await response.json();
    const missingField = ["device_code", "user_code", "verification_uri", "expires_in"].find(
      (field) => body[field] === undefined || body[field] === null || body[field] === "",
    );
    if (missingField) {
      throw new Error(`device authorization response missing ${missingField}`);
    }
    if (
      typeof body.verification_uri !== "string" ||
      !body.verification_uri.startsWith("https://")
    ) {
      throw new Error("device authorization verification_uri was not https");
    }
    if (body.verification_uri.includes(".test")) {
      throw new Error("device authorization used fixture WorkOS provider");
    }
    if (typeof body.expires_in !== "number" || body.expires_in <= 0) {
      throw new Error("device authorization expires_in was not positive");
    }
    return `verification_uri=${body.verification_uri}`;
  }

  async function assertMcpToolsList() {
    const body = await mcpRequest({
      jsonrpc: "2.0",
      id: "tools-list-smoke",
      method: "tools/list",
    });
    const tools = body.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Error("MCP tools/list returned no tools");
    }
    if (!tools.some((tool) => tool?.name === "experiment_results_get")) {
      throw new Error("MCP tools/list did not include experiment_results_get");
    }
    return `${tools.length} tools`;
  }

  async function assertMcpAnalysisBinding() {
    const body = await mcpRequest({
      jsonrpc: "2.0",
      id: "analysis-binding-smoke",
      method: "tools/call",
      params: {
        name: "experiment_results_get",
        arguments: {
          appId: "smoke-app",
          environmentId: "smoke-env",
          experimentId: "smoke-exp",
        },
      },
    });
    if (body.error) {
      throw new Error(`MCP returned ${body.error.code}: ${body.error.message}`);
    }
    const structured = body.result?.structuredContent;
    if (body.result?.isError !== true || structured?.code !== "UNAUTHORIZED") {
      throw new Error("MCP analysis binding did not return expected UNAUTHORIZED tool result");
    }
    return "analysis service binding returned UNAUTHORIZED as expected";
  }

  async function assertSmokeClientCredentials() {
    if (!config.smokeClientSecret) {
      throw new Error("SPLITCH_SMOKE_CLIENT_SECRET is required");
    }
    const response = await fetchWithTimeout(`${config.authBaseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.smokeClientId,
        client_secret: config.smokeClientSecret,
      }),
    });
    assertStatus(response, 200);
    const body = await response.json();
    if (body.token_type !== "Bearer") {
      throw new Error(`expected token_type Bearer, got ${JSON.stringify(body.token_type)}`);
    }
    if (typeof body.access_token !== "string" || body.access_token.split(".").length !== 3) {
      throw new Error("client_credentials response did not include a compact JWT access_token");
    }
    if (typeof body.expires_in !== "number" || body.expires_in <= 0) {
      throw new Error("client_credentials expires_in was not positive");
    }
    smokeAccessToken = body.access_token;
    return `access token minted for ${config.smokeClientId}`;
  }

  async function assertMcpAuthenticatedControlPlane() {
    if (!smokeAccessToken) {
      throw new Error("smoke access token was not minted");
    }
    const body = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: "authenticated-control-plane-smoke",
        method: "tools/call",
        params: {
          name: "apps_get",
          arguments: {
            appId: config.smokeAppId,
          },
        },
      },
      { authorization: `Bearer ${smokeAccessToken}` },
    );
    if (body.error) {
      throw new Error(`MCP returned ${body.error.code}: ${body.error.message}`);
    }
    const structured = body.result?.structuredContent;
    if (body.result?.isError === true && structured?.code === "APP_NOT_FOUND") {
      return "Control Plane accepted bearer and reached apps_get";
    }
    if (body.result?.isError === true && structured?.code === "RATE_LIMITED") {
      return "Control Plane accepted bearer before fail-closed rate-limit guard";
    }
    throw new Error(
      `MCP authenticated Control Plane returned ${JSON.stringify({
        isError: body.result?.isError,
        structuredContent: structured,
      })}`,
    );
  }

  async function mcpRequest(body, options = {}) {
    const headers = { "content-type": "application/json" };
    if (options.authorization) {
      headers.authorization = options.authorization;
    }
    const response = await fetchWithTimeout(`${config.mcpBaseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assertStatus(response, 200);
    return response.json();
  }

  return {
    unauthenticatedProbes: [
      ...config.routes.map((route) => ({
        name: `${route.surface} health`,
        url: route.url,
        run: () => assertHealth(route),
      })),
      {
        name: "Auth OAuth discovery",
        url: `${config.authBaseUrl}/.well-known/oauth-authorization-server`,
        run: assertAuthDiscovery,
      },
      {
        name: "Auth WorkOS device authorization",
        url: `${config.authBaseUrl}/oauth2/device_authorization`,
        run: assertDeviceAuthorization,
      },
      {
        name: "MCP tools/list",
        url: `${config.mcpBaseUrl}/mcp`,
        run: assertMcpToolsList,
      },
      {
        name: "MCP Analysis binding",
        url: `${config.mcpBaseUrl}/mcp`,
        run: assertMcpAnalysisBinding,
      },
    ],
    smokeAuthProbe: {
      name: "Auth smoke client_credentials",
      url: `${config.authBaseUrl}/oauth2/token`,
      run: assertSmokeClientCredentials,
    },
    authenticatedProbes: [
      {
        name: "MCP authenticated Control Plane",
        url: `${config.mcpBaseUrl}/mcp`,
        run: assertMcpAuthenticatedControlPlane,
      },
    ],
  };
}

function assertStatus(response, expected) {
  if (response.status !== expected) {
    throw new Error(`expected HTTP ${expected}, got ${response.status}`);
  }
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) {
    throw new Error(`expected ${name} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
