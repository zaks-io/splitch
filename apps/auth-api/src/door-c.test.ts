import { describe, expect, it } from "vitest";
import { verifyAccessToken } from "./access-token";
import { DEVICE_CODE_GRANT } from "./device-flow";
import {
  ACCESS_SECRET,
  APP,
  CP_AUDIENCE,
  DEVICE_USER,
  MCP_AUDIENCE,
  NOW_MS,
  ORG,
  ORIGIN,
  setupDoorCHarness,
} from "./door-c-test-harness";

/**
 * Door C integration: OAuth discovery is public, device-code grant returns a
 * splitch control-plane token from fixture WorkOS state, and RFC 7009 revoke
 * writes the same revocation marker protected control-plane routes check.
 */

const {
  buildApp,
  formPost,
  mintDeviceToken,
  removeSelectedAppMembership,
  restoreSelectedAppMembership,
} = setupDoorCHarness();

describe("Door C discovery and device flow", () => {
  it("serves unauthenticated OAuth discovery docs with the protected resource pointing to auth-api", async () => {
    const app = buildApp();
    const protectedResource = await app.request(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      resource: CP_AUDIENCE,
      authorization_servers: [ORIGIN],
    });

    const authorizationServer = await app.request(
      `${ORIGIN}/.well-known/oauth-authorization-server`,
    );
    expect(authorizationServer.status).toBe(200);
    const serverMetadata = (await authorizationServer.json()) as {
      agent_auth: { skill: string; identity_types_supported: string[] };
    };
    expect(serverMetadata).toMatchObject({
      issuer: ORIGIN,
      token_endpoint: `${ORIGIN}/oauth2/token`,
      revocation_endpoint: `${ORIGIN}/oauth2/revoke`,
      device_authorization_endpoint: `${ORIGIN}/oauth2/device_authorization`,
      agent_auth: {
        identity_endpoint: `${ORIGIN}/agent/identity`,
        claim_endpoint: `${ORIGIN}/agent/identity/claim`,
        identity_types_supported: ["anonymous", "device_flow"],
      },
    });
    expect(JSON.stringify(serverMetadata)).not.toContain("id_jag");

    const skill = await app.request(serverMetadata.agent_auth.skill);
    expect(skill.status).toBe(200);
    expect(skill.headers.get("content-type")).toContain("text/markdown");
    const skillText = await skill.text();
    expect(skillText).toContain("App ID or slug selector optional");
    expect(skillText).not.toContain("same scope");
    expect(skillText).not.toContain("ID-JAG");
  });

  it("issues a control-plane token for a fixture device grant", async () => {
    const app = buildApp();
    const { accessToken } = await mintDeviceToken(app);
    await expect(
      verifyAccessToken(
        `Bearer ${accessToken}`,
        { accessSecret: ACCESS_SECRET, issuer: ORIGIN, controlPlaneAudience: CP_AUDIENCE },
        Math.floor(NOW_MS / 1000),
      ),
    ).resolves.toMatchObject({ userId: DEVICE_USER, scopes: [`app:${APP}:owner`] });
  });

  it("issues only an exact configured MCP-resource audience", async () => {
    const app = buildApp();
    const { accessToken } = await mintDeviceToken(app, MCP_AUDIENCE);
    await expect(
      verifyAccessToken(
        `Bearer ${accessToken}`,
        { accessSecret: ACCESS_SECRET, issuer: ORIGIN, controlPlaneAudience: MCP_AUDIENCE },
        Math.floor(NOW_MS / 1000),
      ),
    ).resolves.toMatchObject({ userId: DEVICE_USER });
    await expect(
      verifyAccessToken(
        `Bearer ${accessToken}`,
        { accessSecret: ACCESS_SECRET, issuer: ORIGIN, controlPlaneAudience: CP_AUDIENCE },
        Math.floor(NOW_MS / 1000),
      ),
    ).resolves.toBeNull();

    const rejected = await formPost(app, "/oauth2/token", {
      grant_type: DEVICE_CODE_GRANT,
      device_code: "fixture-device-code",
      client_id: "splitch-cli",
      resource: "https://other.splitch.test",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_request" });
  });

  it("revoking a valid App-only token makes authentication reject it with 401", async () => {
    const app = buildApp();
    const { accessToken } = await mintDeviceToken(app);
    const headers = { authorization: `Bearer ${accessToken}` };

    const before = await app.request(`/orgs/${ORG}/trusted-idps`, { headers });
    expect(before.status).toBe(403);
    expect((await before.json()) as { code: string }).toMatchObject({ code: "FORBIDDEN" });

    const revoke = await formPost(app, "/oauth2/revoke", {
      client_id: "splitch-cli",
      token: accessToken,
      token_type_hint: "access_token",
    });
    expect(revoke.status).toBe(200);

    const after = await app.request(`/orgs/${ORG}/trusted-idps`, { headers });
    expect(after.status).toBe(401);
    expect((await after.json()) as { code: string }).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("revokes refresh tokens through the provider path", async () => {
    const app = buildApp();
    const { deviceCode, refreshToken } = await mintDeviceToken(app);

    const revoke = await formPost(app, "/oauth2/revoke", {
      client_id: "splitch-cli",
      token: refreshToken,
      token_type_hint: "refresh_token",
    });
    expect(revoke.status).toBe(200);

    const token = await formPost(app, "/oauth2/token", {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: "splitch-cli",
    });
    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "authorization_pending" });
  });
});

describe("Door C refresh authority", () => {
  it("rotates refresh tokens and reintersects the durable selected App authority", async () => {
    const app = buildApp();
    const { refreshToken } = await mintDeviceToken(app);
    const refreshed = await formPost(app, "/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "splitch-cli",
    });

    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
      app_id: string;
    };
    expect(body.refresh_token).toBe("fixture-refresh-token-1");
    expect(body.app_id).toBe(APP);
    await expect(
      verifyAccessToken(
        `Bearer ${body.access_token}`,
        { accessSecret: ACCESS_SECRET, issuer: ORIGIN, controlPlaneAudience: CP_AUDIENCE },
        Math.floor(NOW_MS / 1000),
      ),
    ).resolves.toMatchObject({ userId: DEVICE_USER, scopes: [`app:${APP}:owner`] });

    const replay = await formPost(app, "/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "splitch-cli",
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects refresh after live selected App membership is revoked", async () => {
    const app = buildApp();
    const { refreshToken } = await mintDeviceToken(app);
    await removeSelectedAppMembership();

    const refreshed = await formPost(app, "/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "splitch-cli",
    });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
    await restoreSelectedAppMembership();
  });
});
