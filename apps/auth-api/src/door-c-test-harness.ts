import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, expect } from "vitest";
import { createApp } from "./app";
import { DEVICE_CODE_GRANT, makeFixtureDeviceFlow } from "./device-flow";
import { makeD1DeviceRefreshSessionStore } from "./device-session-store";
import { makeJtiCache } from "./jti-cache";
import { makeKvRevocationStore } from "./revocation";
import { makePoolBindings } from "./test-bindings-pool";
import { type LocalBindings, makeDoorBDeps, makeFixtureKeypair } from "./test-fixtures";
import { makeTokenSigner, type TokenSigner } from "./token-exchange";
import { makeFixtureWorkOs } from "./workos";

export const ORIGIN = "https://auth.splitch.test";
export const ACCESS_SECRET = "test-access-secret";
export const CP_AUDIENCE = "https://cp.splitch.test";
export const MCP_AUDIENCE = "https://mcp.splitch.test/mcp";
export const NOW_MS = 1_780_000_000_000;
export const ORG = "org_device";
export const APP = "app_device";
export const DEVICE_USER = "user_device_fixture";
const ASSERTION_SECRET = "test-assertion-secret";
const NOW_ISO = "2026-06-29T00:00:00.000Z";

export function setupDoorCHarness() {
  let local: LocalBindings;
  let signer: TokenSigner;

  beforeAll(async () => {
    local = await makePoolBindings();
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
    const doorB = makeDoorBDeps(repo, () => NOW_MS, {
      tokenSigner: signer,
      sessionStore: local.sessionKv,
    });
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
      sessionStore: local.sessionKv,
      revocations: makeKvRevocationStore(local.sessionKv),
    });
  }

  async function seedDeviceOwner(): Promise<void> {
    await local.d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(ORG, "Device Org", ORG, "free", NOW_ISO, NOW_ISO)
      .run();
    await local.d1
      .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(ORG, DEVICE_USER, "owner", NOW_ISO)
      .run();
    await local.d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(APP, ORG, "Device App", "device-app", NOW_ISO, NOW_ISO)
      .run();
    await restoreSelectedAppMembership();
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

  async function mintDeviceToken(app: ReturnType<typeof buildApp>, resource?: string) {
    const auth = await formPost(app, "/oauth2/device_authorization", {
      client_id: "splitch-cli",
      app: "device-app",
    });
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
      app_id: string;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.refresh_token).toBe("fixture-refresh-token");
    expect(body.app_id).toBe(APP);
    expect(body.access_token.split(".")).toHaveLength(3);
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      deviceCode: grant.device_code,
    };
  }

  async function removeSelectedAppMembership(): Promise<void> {
    await local.d1
      .prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(APP, DEVICE_USER)
      .run();
  }

  async function restoreSelectedAppMembership(): Promise<void> {
    await local.d1
      .prepare(
        "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .bind(APP, DEVICE_USER, "owner", NOW_ISO)
      .run();
  }

  return {
    buildApp,
    formPost,
    mintDeviceToken,
    removeSelectedAppMembership,
    restoreSelectedAppMembership,
  };
}
