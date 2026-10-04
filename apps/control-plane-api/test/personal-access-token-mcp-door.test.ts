import { env } from "cloudflare:workers";
import {
  createMcpDelegationHeader,
  MCP_DELEGATION_HEADER,
  type PersonalAccessTokenGrant,
} from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { McpEntrypoint } from "../src/index.js";
import {
  AUDIENCE,
  MCP_DELEGATION_SECRET,
  OWNER,
  setupMcpDoorTestEnv,
  TENANT_A,
  TENANT_B,
  testCtx,
} from "./index-mcp-fixtures.js";

/**
 * SPL-683: a Personal Access Token reaching the Control Plane through the MCP
 * binding. Authority is the owner's LIVE membership clamped by the row's
 * CURRENT grants on every call; read-only grants refuse mutations; a revoked,
 * expired, or re-owned token refuses the next call.
 */

const TOKEN_ID = `pat_${"a".repeat(32)}`;
const TOKEN_HASH = "f".repeat(64);
let testEnv: ControlPlaneApiEnv;
const repo = () => createRepository(env.DB);

beforeAll(async () => {
  testEnv = await setupMcpDoorTestEnv();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM personal_access_tokens").run();
  await seedToken([{ target: `app:${TENANT_A.appId}`, role: "owner", access: "read" }]);
});

async function seedToken(
  grants: PersonalAccessTokenGrant[],
  overrides: { userId?: string; expiresAt?: string | null } = {},
): Promise<void> {
  await repo().personalAccessTokens.insert({
    id: TOKEN_ID,
    userId: overrides.userId ?? OWNER,
    name: "door",
    tokenHash: TOKEN_HASH,
    grants: JSON.stringify(grants),
    expiresAt: overrides.expiresAt === undefined ? null : overrides.expiresAt,
    createdAt: new Date().toISOString(),
  });
}

let jti = 0;
async function call(
  operationId: string,
  method: string,
  path: string,
  body?: unknown,
  tokenHash = TOKEN_HASH,
): Promise<Response> {
  const request = new Request(`${AUDIENCE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  request.headers.set(
    MCP_DELEGATION_HEADER,
    await createMcpDelegationHeader({
      operationId,
      actor: {
        subject: OWNER,
        scopes: [],
        liveMembership: true,
        authDoor: "personal_access_token",
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: tokenHash,
      },
      request,
      secret: MCP_DELEGATION_SECRET,
      jti: `pat-door-delegation-${++jti}-${Date.now()}`,
    }),
  );
  return new McpEntrypoint(testCtx, testEnv).fetch(request);
}

const getApp = (appId: string) => call("apps_get", "GET", `/apps/${appId}`);
const renameApp = (appId: string) =>
  call("apps_update", "PATCH", `/apps/${appId}`, { name: "Renamed by PAT" });

describe("Personal Access Token on the MCP door", () => {
  it("reads inside its grants and nowhere else", async () => {
    expect((await getApp(TENANT_A.appId)).status).toBe(200);
    // OWNER also owns TENANT_A's Org, but the grant names only the App.
    expect((await call("organizations_get", "GET", `/orgs/${TENANT_A.orgId}`)).status).toBe(403);
    expect((await getApp(TENANT_B.appId)).status).toBe(403);
  });

  it("refuses every mutation on a read-only grant", async () => {
    const response = await renameApp(TENANT_A.appId);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: `personal access token grants read-only access to app:${TENANT_A.appId}`,
    });
  });

  it("allows a mutation under a read-write grant, capped at the grant's role", async () => {
    await env.DB.prepare("DELETE FROM personal_access_tokens").run();
    await seedToken([{ target: `app:${TENANT_A.appId}`, role: "admin", access: "read-write" }]);
    expect((await renameApp(TENANT_A.appId)).status).toBe(200);

    await env.DB.prepare("DELETE FROM personal_access_tokens").run();
    // `member` is below the admin role the rename requires, even though the
    // user is a live owner.
    await seedToken([{ target: `app:${TENANT_A.appId}`, role: "member", access: "read-write" }]);
    expect((await renameApp(TENANT_A.appId)).status).toBe(403);
  });

  it("applies a narrowed grant on the next call without rotating the secret", async () => {
    expect((await getApp(TENANT_A.appId)).status).toBe(200);
    await repo().personalAccessTokens.update(OWNER, TOKEN_ID, {
      grants: JSON.stringify([{ target: `app:${TENANT_B.appId}`, role: "owner", access: "read" }]),
    });
    expect((await getApp(TENANT_A.appId)).status).toBe(403);
  });

  it("loses authority the moment live membership is removed", async () => {
    // Raw delete: the repo's last-owner guard would (rightly) refuse it.
    await env.DB.prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(TENANT_A.appId, OWNER)
      .run();
    let status: number;
    try {
      status = (await getApp(TENANT_A.appId)).status;
    } finally {
      await env.DB.prepare(
        "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
        .bind(TENANT_A.appId, OWNER, new Date().toISOString())
        .run();
    }
    expect(status).toBe(403);
  });

  it("refuses the next call once revoked, expired, or owned by someone else", async () => {
    await repo().personalAccessTokens.revoke(OWNER, TOKEN_ID, new Date().toISOString());
    const revoked = await getApp(TENANT_A.appId);
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ code: "CREDENTIAL_REVOKED" });

    for (const overrides of [
      { expiresAt: new Date(Date.now() - 1000).toISOString() },
      { userId: "user_someone_else" },
    ]) {
      await env.DB.prepare("DELETE FROM personal_access_tokens").run();
      await seedToken([{ target: "all", role: "owner", access: "read-write" }], overrides);
      const refused = await getApp(TENANT_A.appId);
      expect(await refused.json()).toMatchObject({ code: "CREDENTIAL_REVOKED" });
    }
  });

  it("refuses a rotated-out secret at once, without waiting for KV to converge", async () => {
    const stale = await call(
      "apps_get",
      "GET",
      `/apps/${TENANT_A.appId}`,
      undefined,
      "0".repeat(64),
    );
    expect(await stale.json()).toMatchObject({ code: "CREDENTIAL_REVOKED" });
  });

  it("refuses a slug-addressed mutation under a read-only grant", async () => {
    const response = await call("apps_update", "PATCH", `/apps/${TENANT_A.appKey}`, {
      name: "Renamed by slug",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect((await getApp(TENANT_A.appId)).status).toBe(200);
  });

  it("reports its clamped authority so an agent can diagnose it without the secret", async () => {
    await env.DB.prepare("DELETE FROM personal_access_tokens").run();
    await seedToken([
      { target: `app:${TENANT_A.appId}`, role: "admin", access: "read-write" },
      { target: `app:${TENANT_B.appId}`, role: "owner", access: "read" },
    ]);
    const response = await call("principal_capabilities_get", "GET", "/principal/capabilities");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      scopes: [`app:${TENANT_A.appId}:admin`],
      membershipWideRead: true,
      personalAccessToken: {
        id: TOKEN_ID,
        writeScopes: [`app:${TENANT_A.appId}:admin`],
        writeAll: false,
      },
    });
  });

  it("never exposes PAT management on the MCP binding", async () => {
    const request = new Request(`${AUDIENCE}/personal-access-tokens`);
    const response = await new McpEntrypoint(testCtx, testEnv).fetch(request);
    expect(response.status).toBe(404);
  });
});
