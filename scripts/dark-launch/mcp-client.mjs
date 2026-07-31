/** Exact-resource MCP client used by the hosted SPL-148 onboarding proof. */

export async function createMcpClient(config) {
  const protectedResourceUrl = `${config.mcpBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  const challenge = await fetch(`${config.mcpBaseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "discover", method: "initialize", params: {} }),
  });
  if (challenge.status !== 401) {
    throw new Error(`MCP unauthenticated discovery expected HTTP 401, got ${challenge.status}`);
  }
  const authenticate = challenge.headers.get("www-authenticate") ?? "";
  if (!authenticate.includes(`resource_metadata="${protectedResourceUrl}"`)) {
    throw new Error("MCP challenge omitted its exact protected-resource metadata URL");
  }

  const metadataResponse = await fetch(protectedResourceUrl);
  if (!metadataResponse.ok) {
    throw new Error(`MCP protected-resource metadata failed with HTTP ${metadataResponse.status}`);
  }
  const metadata = await metadataResponse.json();
  const expectedResource = `${config.mcpBaseUrl}/mcp`;
  if (metadata.resource !== expectedResource) {
    throw new Error(`MCP protected resource mismatch: expected ${expectedResource}`);
  }
  if (
    !Array.isArray(metadata.authorization_servers) ||
    !metadata.authorization_servers.includes(config.authBaseUrl)
  ) {
    throw new Error("MCP metadata omitted the configured authorization server");
  }

  const authorizationMetadataResponse = await fetch(
    `${config.authBaseUrl}/.well-known/oauth-authorization-server`,
  );
  if (!authorizationMetadataResponse.ok) {
    throw new Error(
      `OAuth authorization-server metadata failed with HTTP ${authorizationMetadataResponse.status}`,
    );
  }
  const authorizationMetadata = await authorizationMetadataResponse.json();
  const expectedTokenEndpoint = `${config.authBaseUrl}/oauth2/token`;
  if (authorizationMetadata.token_endpoint !== expectedTokenEndpoint) {
    throw new Error(`OAuth metadata token endpoint mismatch: expected ${expectedTokenEndpoint}`);
  }

  const token = await exactResourceToken(config, expectedResource, expectedTokenEndpoint);
  let requestNumber = 0;

  async function request(method, params) {
    requestNumber += 1;
    const response = await fetch(`${config.mcpBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: `spl-148-${requestNumber}`, method, params }),
    });
    if (!response.ok) throw new Error(`MCP ${method} failed with HTTP ${response.status}`);
    const envelope = await response.json();
    if (envelope.error) {
      throw new Error(`MCP ${method} JSON-RPC error: ${JSON.stringify(envelope.error)}`);
    }
    return envelope.result;
  }

  async function callToolResult(name, args) {
    const result = await request("tools/call", { name, arguments: args });
    return {
      ok: result?.isError !== true,
      status: result?.isError === true ? 400 : 200,
      body: result?.structuredContent,
    };
  }

  return {
    async callTool(name, args) {
      const result = await callToolResult(name, args);
      if (!result.ok) {
        throw new Error(`MCP ${name} returned ${JSON.stringify(result.body)}`);
      }
      return result.body;
    },
    callToolResult,
    async listTools() {
      const result = await request("tools/list");
      return result?.structuredContent?.tools ?? result?.tools ?? [];
    },
    discovery: {
      challengeStatus: challenge.status,
      protectedResourceUrl,
      resource: metadata.resource,
      authorizationServer: config.authBaseUrl,
      tokenEndpoint: authorizationMetadata.token_endpoint,
      exactResourceTokenGranted: token.length > 0,
    },
  };
}

async function exactResourceToken(config, resource, tokenEndpoint) {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.smokeClientId,
      client_secret: config.smokeClientSecret,
      resource,
    }),
  });
  if (!response.ok) {
    throw new Error(`exact-resource smoke token failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  if (typeof body.access_token !== "string") {
    throw new Error("exact-resource token response omitted access_token");
  }
  return body.access_token;
}
