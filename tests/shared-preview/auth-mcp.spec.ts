import { expect, test } from "./fixtures";

test.describe("shared-preview auth and MCP", () => {
  test("OAuth discovery exposes Doors B and C only while Door A is paused", async ({ smoke }) => {
    const metadata = await smoke.authDiscovery();

    expect(metadata.issuer).toBe(smoke.config.authBaseUrl);
    expect(metadata.jwks_uri).toBe(`${smoke.config.authBaseUrl}/.well-known/jwks.json`);
    expect(metadata.token_endpoint).toBe(`${smoke.config.authBaseUrl}/oauth2/token`);
    expect(metadata.device_authorization_endpoint).toBe(
      `${smoke.config.authBaseUrl}/oauth2/device_authorization`,
    );
    expect(metadata.grant_types_supported).toContain("client_credentials");
    expect(metadata.agent_auth).toBeDefined();
    const identityTypes = (metadata.agent_auth as { identity_types_supported?: string[] })
      .identity_types_supported;
    expect(identityTypes).toEqual(expect.arrayContaining(["anonymous", "device_flow"]));
    expect(identityTypes).not.toContain("id_jag");
    expect(JSON.stringify(metadata)).not.toContain("id_jag");
  });

  test("MCP challenges unauthenticated connects with protected-resource metadata", async ({
    smoke,
  }) => {
    const response = await smoke.mcpUnauthorizedConnect();

    expect(response.status()).toBe(401);
    expect(response.headers()["www-authenticate"]).toBe(
      `Bearer realm="splitch", resource_metadata="${smoke.config.mcpBaseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );

    const metadata = await smoke.mcpProtectedResourceMetadata();
    expect(metadata).toMatchObject({
      resource: smoke.config.mcpProtectedResource,
      authorization_servers: [smoke.config.authBaseUrl],
    });
  });

  test("WorkOS device authorization returns a real verification URL", async ({ smoke }) => {
    const body = await smoke.deviceAuthorization();

    expect(body.device_code).toEqual(expect.any(String));
    expect(body.user_code).toEqual(expect.any(String));
    expect(body.verification_uri).toEqual(expect.stringMatching(/^https:\/\//));
    expect(String(body.verification_uri)).not.toContain(".test");
    expect(body.expires_in).toEqual(expect.any(Number));
  });

  test("Auth API publishes the hosted access-token JWKS", async ({ smoke }) => {
    const jwks = await smoke.authJwks();
    const keys = jwks.keys as Array<Record<string, unknown>>;

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(keys[0]?.d).toBeUndefined();
  });

  test("Auth API rejects local fixture Turnstile tokens", async ({ smoke }) => {
    await smoke.assertFixtureTurnstileRejected();
  });

  test("MCP lists agent tools from route contracts", async ({ accessToken, smoke }) => {
    const tools = await smoke.listTools(accessToken);
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("apps_create");
    expect(names).toContain("flags_create");
    expect(names).toContain("flag_config_update");
    expect(names).toContain("flags_test_eval");
  });

  test("MCP rejects unauthenticated tool calls at the transport boundary", async ({ smoke }) => {
    const response = await smoke.callToolUnauthorized("apps_get", {
      appId: smoke.config.smokeAppId,
    });

    expect(response.status()).toBe(401);
    expect(response.headers()["www-authenticate"]).toContain("resource_metadata=");
  });

  test("MCP-audience smoke token reaches Control Plane through delegation", async ({
    accessToken,
    smoke,
  }) => {
    const app = await smoke.callTool<Record<string, unknown>>(accessToken, "apps_get", {
      appId: smoke.config.smokeAppId,
    });

    expect(app).toMatchObject({
      id: smoke.config.smokeAppId,
      organizationId: smoke.config.smokeOrgId,
    });
  });

  test("control-plane smoke token authenticates direct Control Plane reads", async ({
    controlPlaneAccessToken,
    smoke,
  }) => {
    const org = await smoke.controlPlaneGet<Record<string, unknown>>(
      controlPlaneAccessToken,
      `/orgs/${smoke.config.smokeOrgId}`,
    );
    expect(org).toMatchObject({ id: smoke.config.smokeOrgId });

    const apps = await smoke.controlPlaneGet<{ items: Array<Record<string, unknown>> }>(
      controlPlaneAccessToken,
      `/orgs/${smoke.config.smokeOrgId}/apps`,
    );
    expect(apps.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: smoke.config.smokeAppId,
          organizationId: smoke.config.smokeOrgId,
        }),
      ]),
    );

    const app = await smoke.controlPlaneGet<Record<string, unknown>>(
      controlPlaneAccessToken,
      `/apps/${smoke.config.smokeAppId}`,
    );
    expect(app).toMatchObject({
      id: smoke.config.smokeAppId,
      organizationId: smoke.config.smokeOrgId,
    });

    const envs = await smoke.controlPlaneGet<{ items: Array<Record<string, unknown>> }>(
      controlPlaneAccessToken,
      `/apps/${smoke.config.smokeAppId}/envs`,
    );
    expect(envs.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: smoke.config.smokeEnvironmentId })]),
    );
  });
});
