import { PAT_MANAGEMENT_AUTHORIZATION } from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVICE_CODE_GRANT, type DeviceFlowPort } from "./device-flow";
import { decodeJwt } from "./jwks";
import { OAuthError } from "./oauth-errors";
import { form, routeApp } from "./oauth-route-test-harness";
import { memoryKvNamespace } from "./test-kv";
import { makeTokenSigner } from "./token-exchange";

const NOW = 1_780_000_000;
const authorization = PAT_MANAGEMENT_AUTHORIZATION;

function setup(options: { now?: () => number; refreshSession?: boolean } = {}) {
  const provider = {
    authorizeDevice: vi.fn(async () => ({
      device_code: "provider-device-code",
      user_code: "SPLT-TEST",
      verification_uri: "https://auth.splitch.test/device",
      expires_in: 300,
    })),
    exchangeDeviceCode: vi.fn(async () => ({
      userId: "user_device",
      email: "device@splitch.test",
      ...(options.refreshSession === false
        ? {}
        : { refreshToken: "provider-refresh-secret", providerSessionId: "provider-session" }),
    })),
    refreshProviderToken: vi.fn(),
    revokeProviderToken: vi.fn(),
  } satisfies DeviceFlowPort;
  const sessions = {
    remember: vi.fn(),
    lookup: vi.fn(),
    rotate: vi.fn(),
    forget: vi.fn(),
  };
  const sessionStore = memoryKvNamespace();
  const put = vi.spyOn(sessionStore, "put");
  const signer = makeTokenSigner({
    assertionSecret: "test-assertion-secret",
    accessSecret: "test-access-secret",
    issuer: "http://localhost",
    controlPlaneAudience: "https://cp.splitch.test",
  });
  const app = routeApp({
    deviceFlow: provider,
    deviceRefreshSessions: sessions,
    sessionStore,
    tokenSigner: signer,
    now: options.now,
    mcpAudience: "https://mcp.splitch.test",
    smokeClientCredentials: {
      clientId: "smoke-client",
      clientSecret: "smoke-secret",
      userId: "user_smoke",
      scopes: ["org:org_smoke:owner"],
    },
  });
  const post = (path: string, body: Record<string, string>) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: "splitch-cli", ...body }),
    });
  const begin = async (extra: Record<string, string> = {}) => {
    const response = await post("/oauth2/device_authorization", extra);
    expect(response.status).toBe(200);
    return ((await response.json()) as { device_code: string }).device_code;
  };
  const poll = (deviceCode: string, extra: Record<string, string> = {}) =>
    post("/oauth2/token", { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode, ...extra });
  return { provider, sessions, put, post, begin, poll };
}

afterEach(() => vi.restoreAllMocks());

describe("PAT management device authorization", () => {
  it("issues a fresh, scope-free, five-minute token with a jti and no persisted refresh session", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => {}),
    );
    const { begin, poll, sessions, put, provider } = setup();
    const response = await poll(await begin({ authorization }), { authorization });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string };
    expect(body).toMatchObject({
      token_type: "Bearer",
      expires_in: 300,
      user_id: "user_device",
      email: "device@splitch.test",
    });
    expect(body).not.toHaveProperty("refresh_token");
    const claims = decodeJwt(body.access_token).payload;
    expect(claims).toMatchObject({
      typ: "access_token",
      authorization,
      scopes: [],
      auth_door: "device_flow",
      sub: "user_device",
      iss: "http://localhost",
      aud: "https://cp.splitch.test",
      iat: NOW,
      exp: NOW + 300,
      jti: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(provider.exchangeDeviceCode).toHaveBeenCalledWith({
      deviceCode: "provider-device-code",
    });
    for (const operation of Object.values(sessions)) expect(operation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    const output = logs
      .flatMap((log) => log.mock.calls)
      .flat()
      .join("\n");
    expect(output).not.toContain(body.access_token);
    expect(output).not.toContain("provider-refresh-secret");
  });

  it("does not require the provider to return a refresh token or session", async () => {
    const { begin, poll } = setup({ refreshSession: false });
    const response = await poll(await begin({ authorization }), { authorization });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("refresh_token");
  });

  it.each([
    [undefined, authorization],
    ["membership-wide-read", authorization],
    [authorization, undefined],
    [authorization, "membership-wide-read"],
  ])("refuses changing authorization from %s to %s while polling", async (granted, requested) => {
    const { begin, poll, provider, sessions } = setup();
    const response = await poll(
      await begin(granted ? { authorization: granted } : {}),
      requested ? { authorization: requested } : {},
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(provider.exchangeDeviceCode).not.toHaveBeenCalled();
    expect(sessions.remember).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([{ app: "app_selected" }, { scope: "app:app_selected:member" }])(
    "refuses an App-selected step-up initiation %j before provider approval",
    async (selection) => {
      const { post, provider } = setup();
      const response = await post("/oauth2/device_authorization", { authorization, ...selection });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
      expect(provider.authorizeDevice).not.toHaveBeenCalled();
    },
  );

  it("refuses approval for the MCP resource before consuming the provider grant", async () => {
    const { begin, poll, provider } = setup();
    const response = await poll(await begin({ authorization }), {
      authorization,
      resource: "https://mcp.splitch.test",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(provider.exchangeDeviceCode).not.toHaveBeenCalled();
  });

  it("refuses an expired approval before contacting the provider", async () => {
    let now = NOW * 1000;
    const { begin, poll, provider } = setup({ now: () => now });
    const code = await begin({ authorization });
    now += 300_000;
    const response = await poll(code, { authorization });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(provider.exchangeDeviceCode).not.toHaveBeenCalled();
  });

  it("waits for browser approval without creating any refresh session", async () => {
    const { begin, poll, provider, sessions } = setup();
    provider.exchangeDeviceCode.mockRejectedValue(
      new OAuthError("authorization_pending", "pending"),
    );
    const response = await poll(await begin({ authorization }), { authorization });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "authorization_pending" });
    for (const operation of Object.values(sessions)) expect(operation).not.toHaveBeenCalled();
  });
});

describe("PAT management grant isolation", () => {
  it.each<Record<string, string>>([
    { grant_type: "refresh_token", refresh_token: "stolen-refresh-secret" },
    {
      grant_type: "client_credentials",
      client_id: "smoke-client",
      client_secret: "smoke-secret",
    },
    {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      identity_assertion: "identity-assertion",
    },
  ])("refuses authorization on $grant_type without updating a session", async (grant) => {
    const { post, provider, sessions, put } = setup();
    const response = await post("/oauth2/token", { ...grant, authorization });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(provider.refreshProviderToken).not.toHaveBeenCalled();
    for (const operation of Object.values(sessions)) expect(operation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
