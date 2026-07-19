import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAccessToken } from "./access-token";
import { createApp } from "./app";
import { DEVICE_CODE_GRANT, makeFixtureDeviceFlow } from "./device-flow";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import { makeJtiCache } from "./jti-cache";
import { makeKvRevocationStore } from "./revocation";
import {
  type LocalBindings,
  makeDoorBDeps,
  makeFixtureKeypair,
  makeLocalBindings,
} from "./test-fixtures";
import { makeTokenSigner, type TokenSigner } from "./token-exchange";
import { makeFixtureWorkOs } from "./workos";

/**
 * Door C integration: OAuth discovery is public, device-code grant returns a
 * splitch control-plane token from fixture WorkOS state, and RFC 7009 revoke
 * writes the same revocation marker protected control-plane routes check.
 */

const ORIGIN = "https://auth.splitch.test";
const ASSERTION_SECRET = "test-assertion-secret";
const ACCESS_SECRET = "test-access-secret";
const CP_AUDIENCE = "https://cp.splitch.test";
const MCP_AUDIENCE = "https://mcp.splitch.test/mcp";
const NOW_MS = 1_780_000_000_000;
const ORG = "org_device";
const DEVICE_USER = "user_device_fixture";
const NOW_ISO = "2026-06-29T00:00:00.000Z";

let local: LocalBindings;
let signer: TokenSigner;

beforeAll(async () => {
  local = await makeLocalBindings();
  signer = makeTokenSigner({
    assertionSecret: ASSERTION_SECRET,
    accessSecret: ACCESS_SECRET,
    issuer: ORIGIN,
    controlPlaneAudience: CP_AUDIENCE,
  });
  await makeFixtureKeypair();
  await seedDeviceOwner();
});

afterAll(async () => {
  await local.dispose();
});

function buildApp() {
  const repo = createRepository(local.d1);
  const doorB = makeDoorBDeps(repo, () => NOW_MS, { tokenSigner: signer });
  return createApp({
    repo,
    accessSecret: ACCESS_SECRET,
    controlPlaneAudience: CP_AUDIENCE,
    mcpAudience: "https://mcp.splitch.test",
    now: () => NOW_MS,
    tokenSigner: signer,
    idJag: {
      repo,
      jtiCache: makeJtiCache(local.kv),
      workos: makeFixtureWorkOs(),
      fetchJwks: async () => ({ keys: [] }),
      authApiOrigin: ORIGIN,
      now: () => NOW_MS,
    },
    register: doorB.register,
    claim: doorB.claim,
    deviceFlow: makeFixtureDeviceFlow(),
    deviceRefreshSessions: makeD1DeviceRefreshSessionStore(repo, {
      cache: local.sessionKv,
      now: () => NOW_MS,
    }),
    revocations: makeKvRevocationStore(local.sessionKv),
  });
}

async function seedDeviceOwner(): Promise<void> {
  await local.d1
    .prepare(
      "INSERT INTO organizations (id, name, plan, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
    .bind(ORG, "Device Org", "free", NOW_ISO, NOW_ISO)
    .run();
  await local.d1
    .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(ORG, DEVICE_USER, "owner", NOW_ISO)
    .run();
}

async function formPost(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: Record<string, string>,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

interface MintedDeviceToken {
  accessToken: string;
  refreshToken: string;
  deviceCode: string;
}

async function mintDeviceToken(
  app: ReturnType<typeof buildApp>,
  resource?: string,
): Promise<MintedDeviceToken> {
  const auth = await formPost(app, "/oauth2/device_authorization", { client_id: "splitch-cli" });
  expect(auth.status).toBe(200);
  const grant = (await auth.json()) as { device_code: string };

  const token = await formPost(app, "/oauth2/token", {
    grant_type: DEVICE_CODE_GRANT,
    device_code: grant.device_code,
    client_id: "splitch-cli",
    ...(resource ? { resource } : {}),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as {
    access_token: string;
    token_type: string;
    refresh_token: string;
  };
  expect(body.token_type).toBe("Bearer");
  expect(body.refresh_token).toBe("fixture-refresh-token");
  expect(body.access_token.split(".")).toHaveLength(3);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    deviceCode: grant.device_code,
  };
}

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
    expect(await skill.text()).not.toContain("ID-JAG");
  });

  it("issues a control-plane token for a fixture device grant", async () => {
    const app = buildApp();
    await mintDeviceToken(app);
  });

  it("issues only an exact configured MCP-resource audience", async () => {
    const app = buildApp();
    const { accessToken } = await mintDeviceToken(app, MCP_AUDIENCE);
    await expect(
      verifyAccessToken(
        `Bearer ${accessToken}`,
        { accessSecret: ACCESS_SECRET, controlPlaneAudience: MCP_AUDIENCE },
        Math.floor(NOW_MS / 1000),
      ),
    ).resolves.toMatchObject({ userId: DEVICE_USER });
    await expect(
      verifyAccessToken(
        `Bearer ${accessToken}`,
        { accessSecret: ACCESS_SECRET, controlPlaneAudience: CP_AUDIENCE },
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

  it("revoking a token makes the protected route reject it with 401", async () => {
    const app = buildApp();
    const { accessToken } = await mintDeviceToken(app);
    const headers = { authorization: `Bearer ${accessToken}` };

    const before = await app.request(`/orgs/${ORG}/trusted-idps`, { headers });
    expect(before.status).toBe(200);

    const revoke = await formPost(app, "/oauth2/revoke", {
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
